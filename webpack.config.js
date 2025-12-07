import path from 'path';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Generate unique BUILD_ID at build time
// This changes with each build, forcing clients to refresh after deployments
const BUILD_ID = `build_${Date.now()}`;

export default {
  entry: './src/index.js',
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
  plugins: [
    // Inject BUILD_ID into the bundle at compile time
    new webpack.DefinePlugin({
      __BUILD_ID__: JSON.stringify(BUILD_ID)
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html',
      title: 'YZSocialC - DHT Network'
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/wasm', to: 'wasm', noErrorOnMissing: true }
      ]
    })
  ],
  experiments: {
    asyncWebAssembly: true
  },
  devServer: {
    static: path.join(__dirname, 'dist'),
    port: 3000,
    hot: true,
    open: true
  },
  resolve: {
    fallback: {
      "crypto": false,
      "stream": false,
      "buffer": false
    }
  }
};