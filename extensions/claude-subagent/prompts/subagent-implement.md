---
description: Explore gathers context, Plan builds the plan, general-purpose executes it
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "Explore" agent to find all code relevant to: $@
2. Then, use the "Plan" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "general-purpose" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
