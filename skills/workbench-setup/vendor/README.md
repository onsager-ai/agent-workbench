# Vendored PyYAML

PyYAML 6.0.3 supplies the pure-Python YAML loader without pip or network access at installation time.

Source: https://files.pythonhosted.org/packages/source/p/pyyaml/pyyaml-6.0.3.tar.gz

SHA256: `d76623373421df22fb4cf8817020cbb7ef15c725b9d5e45f17e189bfc384190f`

To update, download the new sdist into a fresh temporary directory and verify its published SHA256 before extracting into another empty temporary directory. Use an isolated interpreter (`python3 -I`) when reading the archive. Copy only `lib/yaml/*.py` and `LICENSE` into `yaml/`, without modifying the files. Update this version, URL and hash, and run the configuration tests. Workbench uses `yaml.safe_load` only.
