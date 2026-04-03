# Product Requirements Document (PRD)

## Product Name
AI Dev Agent

## Product Summary
An AI-powered local dev assistant that watches code changes, builds context, detects intent, and generates high-quality implementation prompts (safe and feature tracks).

## Target Users
- Solo developers
- Small engineering teams
- Agencies managing multiple client codebases

## Core Jobs To Be Done
1. Turn code + project docs into actionable implementation prompts.
2. Reduce context switching and manual prompt-writing.
3. Prioritize high-impact changes from full-repo scans.

## Primary Workflows
1. Developer edits code.
2. Watcher/context pipeline runs.
3. Prompt(s) generated + ranked (safe/feature/master).
4. Developer executes prompt and iterates.

## Success Metrics
- Prompt acceptance rate (% prompts used without major rewrite)
- Time-to-implement (before vs after)
- % of prompts tied to documented product goals
- Reduction in low-value/redundant prompts

## In Scope (Now)
- Local watcher + periodic fullscan
- Context intelligence + intent detection
- Dual prompt tracks (safe, feature)
- Master prompt generation
- Webhook trigger service
- MCP context server

## Out of Scope (Now)
- Full SaaS billing/subscription backend
- Multi-tenant hosted control plane
- Persistent cloud analytics dashboard

## Constraints
- Must work from project root (`process.cwd()`)
- Must require `projectdocs` grounding files
- Must preserve existing code behavior by default (safe path)

## Risks
- Poor docs quality leads to weak prompt quality
- Overly strict gating can block runs if docs are not maintained
- LLM variability may create inconsistent prompt outputs

## Milestones
- M1: Reliable local pipeline with strict docs grounding
- M2: Prompt quality/ranking improvements
- M3: Sellable packaging and onboarding
