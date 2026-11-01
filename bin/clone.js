#!/usr/bin/env node

import("../dist/cli.js")
  .then(({ main }) => main(process.argv.slice(2)))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 4;
    },
  );
