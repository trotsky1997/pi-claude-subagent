---
description: Explore gathers context and Plan produces an implementation plan
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "Explore" agent to find all code relevant to: $@
2. Then, use the "Plan" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.
