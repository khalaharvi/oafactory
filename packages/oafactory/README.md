# oafactory

An open software factory: agents write the changes, a deterministic Gate decides what merges, and every run leaves a receipt.

```bash
oafactory demo     # the whole lifecycle on an in-memory Git host
oafactory init     # write .oafactory/factory.yaml in shadow mode
oafactory ready    # check that the config protects what it must
```

Status: 0.1 alpha. Documentation, the specification and the list of what has and has not been verified are in the repository: https://github.com/khalaharvi/oafactory
