# Debug Prompt Template

Problem: {{task}}

Repository/context:
{{repository_context}}

Observed behavior:
{{symptoms}}

Instructions:
1. Reproduce or localize the issue before editing when possible.
2. Identify the likely cause and cite files/functions involved.
3. Make the smallest fix that addresses the cause.
4. Run the narrowest useful verification first, then broader checks if cheap.
5. If the issue cannot be reproduced, document the evidence and safest next diagnostic step.

Constraints:
- Do not weaken tests to hide failures.
- Do not delete error handling unless justified.
- Do not make unrelated refactors.

Output contract:

```text
Cause:
Fix:
Files changed:
Verification:
Risks:
Follow-ups:
```
