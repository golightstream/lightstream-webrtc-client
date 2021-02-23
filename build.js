const esbuild = require('esbuild')

esbuild
  .build({
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    entryPoints: ['src/webrtc'],
    format: 'esm',
    minify: true,
    bundle: true,
    sourcemap: true,
    globalName: 'window',
    tsconfig: './tsconfig.json',
    target: 'es6',
    outfile: 'dist/main.js',
  })
  .catch((e) => {
    console.warn(e)
  })
