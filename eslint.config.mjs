import { defineConfig } from 'eslint/config';
import { mainConfig } from '../eslint.base.mjs';
import nodePath from 'node:path'

export const paths = {
  ignores: ['dist/**', 'eslint.config.mjs', "**/*.js"],
  files: ["**/*.ts"],
}

export const config = ({ path = ".", baseConfig, ignores: baseIgnores = [], files: baseFiles = [] }) => {
  const files = [...paths.files, ...baseFiles].map((file) => nodePath.join(path, file))
  const ignores = [...paths.ignores, ...baseIgnores].map((ignore) => nodePath.join(path, ignore))
  const configuredPaths = { files, ignores };
  return defineConfig(
    ...baseConfig({ ...configuredPaths, tsconfigRootDir: import.meta.dirname }),
  );
}

const defaultConfig = config({baseConfig: mainConfig, ...paths})

export default defaultConfig;
