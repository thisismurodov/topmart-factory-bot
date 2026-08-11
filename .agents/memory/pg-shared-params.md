---
name: PG shared params arrays across queries
description: Postgres rejects extra bind parameters; sharing one params array across several pool.query calls breaks silently-untested endpoints.
---
Rule: each `pool.query` must receive an array whose every element is referenced by the SQL (`bind message supplies N parameters, but prepared statement requires M` otherwise). Also, WHERE fragments built against one alias (`da.telegram_id`) must not be spliced into subqueries lacking that alias.
**Why:** /distribution/daily-visits 500'd for every request because a reasons query reused a shared params array containing an unused `dow` param, and the agent filter fragment referenced `da` inside CTEs without it.
**How to apply:** when adding a query to an endpoint with a shared params array, give it its own params + where builder; test the endpoint with and without each filter.
