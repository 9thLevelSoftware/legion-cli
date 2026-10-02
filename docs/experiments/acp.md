# ACP adapter experiment

ACP is disabled unless configuration explicitly contains an enabled command:

```yaml
adapter:
  default: acp
  acp:
    command: your-acp-agent
    args: []
    enabled: true
```

`legion-cli init --adapter acp --acp-command your-acp-agent` writes this
opt-in configuration. The adapter uses the official TypeScript SDK, negotiates
the protocol, opens and closes a session, streams progress, forwards
cancellation, and denies permission requests by default. It runs the ACP
command through the selected Legion sandbox wrapper. Only `end_turn` is a
successful completion; refusal and turn/token limits fail the lifecycle run.

For an operator-owned real-agent smoke, configure a disposable project with a
known ACP stdio command, run `legion-cli doctor`, then execute one contracted
task with `legion-cli execute <task-id>`. Confirm the run log records the ACP
protocol/session and that denied write permission leaves the project unchanged.
This smoke is opt-in because Legion does not install or select a third-party ACP
agent. The deterministic fixture validates protocol behavior; no external ACP
agent was exercised for this implementation report.
