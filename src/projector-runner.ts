// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// retcon's in-process synchronous-dispatch hook on top of the Channel
// substrate. Walks each registered Task's Input recursively for TaskRef
// dependencies, topologically sorts, and dispatches `apply()` in dependency
// order inside emit's BEGIN IMMEDIATE transaction.
//
// This file is RETCON's runner — it is NOT part of `@playtiss/core/channel`.
// The Channel package exposes only emit + storage + Task primitives; how a
// consumer dispatches its Tasks is the consumer's choice. retcon's choice
// for v0.3: synchronous-on-emit so projections stay transactionally
// consistent with the event row that triggered them.
//
// Future consumers (arianna, playfilo) might use a different runner — e.g.,
// async pull from `subscribe()` once that ships in v0.4.

import {
  type Task,
  type TaskId,
  type TaskInput,
  isTaskRef,
} from './channel-types.js'

/**
 * Walk a Task's `input` dict recursively and collect every TaskRef-shaped
 * value's `id`. These are the topological dependencies of the Task.
 *
 * Recurses into objects and arrays; stops at TaskRefs (the TaskRef itself is
 * a leaf — we don't walk into its `.id` string). Primitives are ignored.
 *
 * Pure function. Tested directly in projector-runner.test.ts so the
 * dependency-extraction algorithm has a regression guard.
 */
export function depsOf(input: TaskInput): TaskId[] {
  const out: TaskId[] = []
  function walk(value: unknown): void {
    if (isTaskRef(value)) {
      out.push(value.id)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v)
    }
  }
  walk(input)
  return out
}

/**
 * Topologically sort Tasks by their TaskRef dependencies (declared in each
 * Task's Input dict). Returns Tasks in dependency order — every Task appears
 * after all the Tasks it depends on.
 *
 * Throws on cycles. Throws if a TaskRef points at an unregistered TaskId
 * (defensive; v0.3 doesn't support cross-channel refs).
 *
 * Order among independent Tasks is stable: insertion order in the input
 * array. This makes the sort deterministic for tests.
 */
export function topoSort(tasks: ReadonlyArray<Task>): Task[] {
  const byId = new Map<TaskId, Task>()
  for (const t of tasks) byId.set(t.id, t)

  const visited = new Set<TaskId>()
  const visiting = new Set<TaskId>()
  const out: Task[] = []

  function visit(t: Task, path: TaskId[]): void {
    if (visited.has(t.id)) return
    if (visiting.has(t.id)) {
      const cycle = [...path, t.id].slice(path.indexOf(t.id))
      throw new Error(`task dependency cycle: ${cycle.join(' → ')}`)
    }
    visiting.add(t.id)
    for (const depId of depsOf(t.input)) {
      const dep = byId.get(depId)
      if (!dep) {
        throw new Error(
          `task ${t.id} depends on unregistered TaskId ${depId} `
          + `(action=${t.action}). Register the dependency before this Task, `
          + `or remove the TaskRef.`,
        )
      }
      visit(dep, [...path, t.id])
    }
    visiting.delete(t.id)
    visited.add(t.id)
    out.push(t)
  }

  // Iterate input order so independent Tasks emerge in insertion order
  // (deterministic for tests + reads naturally in registration order when
  // no deps disagree).
  for (const t of tasks) visit(t, [])
  return out
}

/**
 * Build a per-topic dispatch index from a topo-sorted Task list. For each
 * topic, lists every Task whose `input.topics` includes that topic, IN
 * dependency order (preserved from the topo-sort).
 *
 * O(N*M) build where N=tasks, M=avg topics per task. Built once at registration
 * time, used on every emit. Not on the hot path.
 *
 * Returns a fresh Map; safe to retain. Empty topic list → empty entries.
 */
export function buildTopicIndex(
  sortedTasks: ReadonlyArray<Task>,
): Map<string, Task[]> {
  const index = new Map<string, Task[]>()
  for (const task of sortedTasks) {
    const topics = task.input.topics ?? []
    for (const topic of topics) {
      const list = index.get(topic) ?? []
      list.push(task)
      index.set(topic, list)
    }
  }
  return index
}

/**
 * The dispatch-order helper. Given a topic and the topic-indexed Tasks
 * (already in dep order), returns the Tasks to dispatch for an event of
 * that topic. Trivial wrapper kept as a separate function so callers don't
 * have to know about the Map's emptiness convention.
 */
export function dispatchOrderForTopic(
  topic: string,
  topicIndex: ReadonlyMap<string, Task[]>,
): Task[] {
  return topicIndex.get(topic) ?? []
}
