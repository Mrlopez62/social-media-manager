# Incident Drill Evidence

Generated drill evidence files are stored here.

Create a new drill record with:

```bash
npm run ops:drill:init -- --scenario dead-letter-spike --environment staging --commander "Your Name"
```

Recommended scenario values:
- `dead-letter-spike`
- `meta-refresh-failure-burst`

Validate that at least one evidence file is fully completed:

```bash
npm run ops:drill:validate
```
