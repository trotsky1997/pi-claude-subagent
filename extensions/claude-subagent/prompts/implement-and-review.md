---
description: general-purpose implements, verification reviews, general-purpose applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "general-purpose" agent to implement: $@
2. Then, use the "verification" agent to review and verify the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "general-purpose" agent to apply the feedback from the verification step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
