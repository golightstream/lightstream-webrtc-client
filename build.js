const path = require('path')

module.exports = {
  entry: './src/webrtc.js',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'main.js',
    library: 'lightstreamWebrtcClient',
    libraryTarget: 'umd',
  },
}
