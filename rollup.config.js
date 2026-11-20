import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';

// 输出目录可被 check-dist 覆盖到临时目录，以便比对「当前 dist」与「重新构建的结果」
const distDir = process.env.DIST_DIR || 'dist';

export default {
  input: 'src/index.ts',
  output: {
    file: `${distDir}/index.js`,
    format: 'es',
    sourcemap: true,
  },
  external: ['axios'],
  plugins: [
    json(),
    resolve(),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      // outDir 必须与 Rollup 的 file 同目录，tsconfig 里写死的 ./dist 会与临时目录冲突
      outDir: `./${distDir}`,
      declarationDir: `./${distDir}/types`,
    }),
  ],
};
