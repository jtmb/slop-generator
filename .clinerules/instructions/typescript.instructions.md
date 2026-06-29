# TypeScript Conventions

## TypeScript Configuration

Your `tsconfig.json` must be strict.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

- **`strict: true`**: enables all strict type-checking flags. Not optional — add it to every project.
- **`noUncheckedIndexedAccess`**: `obj[key]` returns `T | undefined`. Catches the most common runtime error.
- **`noUnusedLocals`/`noUnusedParameters`**: dead code is a bug. Use `_` prefix for intentionally unused params.
- **`skipLibCheck: true`**: don't type-check `node_modules`. Faster builds, fewer spurious errors.

## Type Safety — Mandatory

Never use `any` except at API boundaries with explicit justification.

```typescript
// Bad — any infects everything it touches
function process(data: any): any {
    return data.value;
}

// Good — use unknown and narrow
function process(data: unknown): string {
    if (typeof data === "object" && data !== null && "value" in data) {
        return String((data as { value: unknown }).value);
    }
    throw new Error("Invalid data");
}
```

- **Use `unknown` over `any`**: forces you to narrow the type before use
- **Use type predicates** for runtime validation:

```typescript
function isUser(obj: unknown): obj is User {
    return typeof obj === "object" && obj !== null && "id" in obj && "email" in obj;
}
```

- **Use `as` casts sparingly**: each cast is an assertion you're betting correctness on
- **Use branded types** for nominal typing when needed:

```typescript
type UserId = string & { readonly __brand: "UserId" };
function createUserId(id: string): UserId { return id as UserId; }
```

## Error Handling

Use typed errors, not string matching.

```typescript
class AppError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = "AppError";
    }
}

// Catch and handle by type, not message text
try {
    await doSomething();
} catch (err) {
    if (err instanceof AppError) {
        return { error: err.message, code: err.code };
    }
    throw err; // Re-throw unexpected errors
}
```

- **Never `catch (e)` without re-throwing or handling**: swallowed errors are debugging nightmares
- **Use `instanceof` checks**, never check `err.message.includes("timeout")`
- **Don't `throw` string literals**: always `throw new Error()`
