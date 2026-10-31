#!/usr/bin/env python3
"""Run the Clone CLI from a standalone executable."""

import sys

# The server import is explicit so PyInstaller includes the module that the CLI
# loads only when the serve command runs.
import server  # noqa: F401
from cli import main


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
