module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
    es2022: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true
    }
  },
  ignorePatterns: ['node_modules/', 'dist/', 'build/'],
  rules: {
    'no-unused-vars': 'warn',
    'no-undef': 'error'
  }
};
