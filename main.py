#!/usr/bin/env python3
"""Entry: exec the vendored static Go forge binary. The Go binary owns the whole
lifecycle (bind ephemeral port, register with MAKEFUN_ENV_URL, poll /done, exit 0)."""
import os

here = os.path.dirname(os.path.abspath(__file__))
binary = os.path.join(here, "forge-static")
os.environ["GOGC"] = "400"
os.environ["GOMEMLIMIT"] = "4GiB"
os.execv(binary, [binary])
