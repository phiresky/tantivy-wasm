const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");
const { trueFunc } = require("boolbase");

module.exports = {
  entry: {
    index: "./src",
  },
  devtool: false,
  mode: "development",
  output: {
    path: path.resolve(__dirname, "dist"),
  },
  experiments: {
    asyncWebAssembly: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      templateContent: `<!doctype html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>

<div id="root"></div>`,
    }),
    new WasmPackPlugin({
      crateDirectory: path.resolve(__dirname, "."),
    }),
  ],
  resolve: {
    extensions: [".js", ".ts", ".tsx"],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "esbuild-loader",
        options: {
          loader: "tsx", // Or 'ts' if you don't need tsx
          target: "es2020",
        },
      },
    ],
  },
  mode: "development",
};
