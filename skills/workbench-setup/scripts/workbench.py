#!/usr/bin/env python3
"""Compatibility shim: hands off to workbench.mjs.

Launchers installed before the Node port run `python3 workbench.py install` after a skills update.
This file exists only so those installs can upgrade; it may be removed in a later release.
"""
import os
import sys

script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workbench.mjs")
os.execvp("node", ["node", script, *sys.argv[1:]])
