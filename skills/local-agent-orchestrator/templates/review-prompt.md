# Review Prompt Template

Review target: {{task}}

Repository/context:
{{repository_context}}

Instructions:
1. Inspect the relevant diff/files and repo instructions.
2. Focus on correctness, regressions, security/safety, maintainability, and test coverage.
3. Do not make changes unless explicitly asked; produce review findings.
4. Separate blocking issues from non-blocking suggestions.
5. Include concrete file/function references where possible.

Output contract:

```text
Verdict:
Blocking issues:
Non-blocking suggestions:
Verification gaps:
Recommended next step:
```
