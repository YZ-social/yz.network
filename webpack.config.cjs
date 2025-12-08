const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry: './src/index.js',
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
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
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    }),
    // Write bundle hash to file for server-side version checking
    // This plugin runs after compilation to extract the actual contenthash
    {
      apply: (compiler) => {
        compiler.hooks.afterEmit.tap('WriteBundleHash', (compilation) => {
          // Find the main bundle's hash from the compilation
          const stats = compilation.getStats().toJson();
          const mainChunk = stats.assets.find(a => a.name.startsWith('bundle.') && a.name.endsWith('.js'));
          if (mainChunk) {
            // Extract hash from filename like "bundle.492e859ac8d78db9c881.js"
            const match = mainChunk.name.match(/bundle\.([a-f0-9]+)\.js/);
            if (match) {
              const bundleHash = match[1];
              const hashFilePath = path.resolve(__dirname, 'dist', 'bundle-hash.json');
              fs.writeFileSync(hashFilePath, JSON.stringify({ hash: bundleHash, timestamp: Date.now() }));
              console.log(`\n📝 Bundle hash written to dist/bundle-hash.json: ${bundleHash}\n`);
            }
          }
        });
      }
    }
  ],
  devtool: 'eval-cheap-module-source-map'
};