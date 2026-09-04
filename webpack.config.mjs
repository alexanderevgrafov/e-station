import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Only the built bundle is deployed - client/ never runs on the device. The
// output lives in its own subdirectory so `clean` can wipe stale hashed
// bundles without touching anything else already in public/.
export default (_env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: path.join(HERE, 'client', 'index.tsx'),
    output: {
      path: path.join(HERE, 'public', 'editor'),
      filename: isProduction ? '[name].[contenthash:8].js' : '[name].js',
      publicPath: '/editor/',
      clean: true,
    },
    resolve: {
      // The '...' keeps webpack's defaults, so importing a bare '.ts' path
      // (as the shared src/types.ts imports do) still resolves.
      extensions: ['.tsx', '.ts', '...'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          // esbuild rather than ts-loader: ts-loader needs tsconfig to emit,
          // which conflicts with the allowImportingTsExtensions + noEmit
          // combination the shared-types imports rely on. Types are checked
          // separately by `yarn typecheck`.
          loader: 'esbuild-loader',
          options: { target: 'es2022', tsconfig: path.join(HERE, 'tsconfig.client.json') },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.join(HERE, 'client', 'index.html'),
        filename: 'index.html',
      }),
    ],
    devtool: isProduction ? false : 'eval-source-map',
    performance: { hints: false },
    stats: 'minimal',
  };
};
