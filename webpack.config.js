const path = require("path");
const nodeExternals = require("webpack-node-externals");

module.exports = {
  target: "node",
  node: {
    __dirname: false,
    __filename: false
  },
  externals: [nodeExternals()],
  resolve: {
    extensions: [".ts"],
  },
  devtool: "source-map",
  entry: {
    server: ["./src/index.ts"]
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.(ts)$/,
        use: ["ts-loader"],
        exclude: /node_modules/
      },
    ]
  }
};
