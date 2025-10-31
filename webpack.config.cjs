const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      },
      {
        test: /\.wasm$/,
        type: 'webassembly/async'
      }
    ]
  },
  experiments: {
    asyncWebAssembly: true
  },
  devServer: {
    static: path.join(__dirname, 'dist'),
    host: '0.0.0.0',
    port: 3000,
    hot: true,
    open: false,
    allowedHosts: 'all'
  },
  resolve: {
    extensions: ['.js', '.mjs', '.json'],
    fallback: {
      "crypto": false,
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer"),
      "events": require.resolve("events"),
      "util": require.resolve("util"),
      "url": require.resolve("url"),
      "querystring": require.resolve("querystring-es3"),
      "process": require.resolve("process/browser")
    },
    alias: {
      'process/browser': require.resolve('process/browser')
    }
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
      title: 'YZSocialC - DHT Network'
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/wasm', to: 'wasm', noErrorOnMissing: true }
      ]
    }),
    new (require('webpack')).ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    })
  ],
  devtool: 'eval-cheap-module-source-map'
};