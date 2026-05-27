# Structural Analysis Reference

This document defines the vocabulary and framework for Stage 2 of a PR review. Every concept here comes from John Ousterhout's *A Philosophy of Software Design*. Use these as precise analytical tools — not as generic advice to parrot back.

The goal is to evaluate whether a PR **increases or decreases the complexity of the system**, and to identify specific structural patterns that drive that change.

---

## The Central Problem: Complexity

Complexity is anything in the structure of a system that makes it hard to understand or modify. It manifests in three ways:

1. **Change amplification** — a simple change requires modifying many places.
2. **Cognitive load** — a developer must hold too much context to work safely.
3. **Unknown unknowns** — it's not obvious what needs changing or what might break.

Complexity is **incremental**. No single PR makes a system incomprehensible. But each PR that adds a small amount of gratuitous complexity contributes to a system that eventually resists change. Your job is to spot those increments.

### How to apply this

When reviewing a PR, ask: does this change make any of these three symptoms worse? Be specific about *which* symptom and *where*.

---

## Deep Modules vs. Shallow Modules

A **deep module** provides powerful functionality behind a simple interface. The implementation is complex; the interface hides that complexity from callers.

A **shallow module** has an interface that is complex relative to the functionality it provides. The caller must understand nearly as much to use the module as they would to implement it themselves.

### The test

For any new class, function, or module in a PR, compare the **interface** (parameters, return types, exceptions, side effects the caller must know about) against the **implementation** (what happens inside). If the interface is nearly as complex as the implementation, the module is shallow.

### Concrete examples

**Deep module — Unix file I/O:**
The interface is five calls: `open`, `read`, `write`, `lseek`, `close`. Behind this sits an enormous implementation handling disk layout, buffering, permissions, concurrent access, device drivers, and network filesystems. Callers need none of this knowledge.

**Shallow module — a wrapper that adds nothing:**
```java
private void addNullValueForAttribute(String attribute) {
    data.put(attribute, null);
}
```
This method provides no abstraction. Its interface (method name, parameter) is as complex as its implementation (one map put). The caller still needs to know about `data` and that the value will be `null`. The method adds a symbol to the codebase without reducing cognitive load.

**Shallow module — classitis:**
Java's file I/O libraries (before NIO) required composing `FileInputStream`, `BufferedInputStream`, and `ObjectInputStream` just to read a serialised object from a file. Each class was shallow individually — the real power only appeared when stacked. This forces callers to understand and assemble the layers themselves, pushing complexity upward.

### What to flag in a PR

- New functions/methods that are shorter than their signature + docstring.
- Wrapper classes that delegate everything to an inner object with the same interface.
- "Helper" functions called from exactly one place that don't hide meaningful decisions.

---

## Information Hiding & Information Leakage

**Information hiding** means embedding a design decision inside a module so that it doesn't affect the module's interface. This is the primary mechanism for creating deep modules.

**Information leakage** occurs when a design decision appears in multiple modules. If two modules both know about a file format, a protocol encoding, or an internal data structure, that knowledge has leaked.

### Temporal decomposition

A common cause of information leakage: splitting code into modules based on the order things happen at runtime (read file → process → write file). This often means multiple modules share knowledge of the same data format, even though that knowledge could be encapsulated in one place.

**Example:** Two classes — one that reads a config file and one that writes it — both need to know the file format. If the format changes, both classes must change. Better: a single class that owns the format and provides `load`/`save` methods.

### What to flag in a PR

- Two modules that both reference the same wire format, serialisation scheme, or data layout.
- A change to an internal representation that forces changes in other files.
- Modules split along temporal lines ("first we fetch, then we parse, then we validate") where each step knows about the others' data structures.
- Interface documentation that describes implementation details (what data structure is used, what algorithm runs, what order things happen internally).

---

## Different Layer, Different Abstraction

Each layer in a system should present a fundamentally different abstraction from the layers above and below. If adjacent layers have similar method signatures, something is wrong — one layer is probably not doing enough work to justify its existence.

### Pass-through methods

A **pass-through method** does little or nothing except call another method with the same or very similar signature. It's a strong signal that two layers are at the same abstraction level.

```
class TextDocument {
    void insertText(Position pos, String text) {
        textArea.insertText(pos, text);  // just delegates
    }
}
```

This forces the caller to navigate two layers that provide the same abstraction. Either the outer layer should add meaningful logic, or the caller should use the inner layer directly.

### Pass-through variables

A **pass-through variable** is threaded through a chain of methods that don't use it, only to deliver it to a deeply-nested call. This is information leakage — every method in the chain becomes aware of a concern that only the innermost method cares about.

**Solutions:**
- Add the variable to an object already shared between layers (e.g., a context or config object).
- Move the computation that needs the variable to a layer that already has access to it.
- If the variable represents system-wide state, consider whether it belongs in a shared context rather than being passed explicitly.

### Decorators and wrappers

Decorator classes often produce shallow modules. A decorator wrapping `InputStream` to add buffering is reasonable only if the decorator provides a meaningfully different abstraction. A decorator that adds logging by wrapping every method with "log then delegate" is shallow — it mirrors the entire interface and adds minimal abstraction.

### What to flag in a PR

- New methods whose body is a single delegation call to another method with a matching signature.
- Parameters added to multiple method signatures in a chain, only consumed at one end.
- New decorator/wrapper classes whose methods all follow the pattern "call inner.sameMethod()".

---

## Pull Complexity Downward

When there's a hard design decision — what default to use, how to retry, what error recovery to perform — it's almost always better for the **implementer** to handle it than to push it to the **caller**. Implementers handle complexity once; callers handle it every time they call.

### Configuration parameters

Every configuration parameter represents complexity pushed to the caller. Sometimes that's necessary, but often the implementer can compute a good default. If a PR introduces a new config parameter, ask: could the module determine this itself?

**Example:** Instead of requiring callers to specify a retry timeout, a module could measure response times at runtime and compute a reasonable retry interval automatically.

### Defining errors out of existence

Exception handling is one of the largest sources of complexity. Where possible, design the interface so error conditions cannot arise.

**Example — Tcl's `unset` command:**
The original design threw an exception if you tried to unset a variable that didn't exist. But the caller's intent is "make sure this variable doesn't exist." If it already doesn't exist, the intent is satisfied. The redesigned version defines `unset(x)` as "ensure `x` is not set" — which is a no-op if `x` wasn't set. The error condition disappears.

**Example — text editor selection:**
Instead of checking `if (selection exists)` before every operation, define selection as always present but sometimes zero-length. Operations on an empty selection are naturally no-ops. The error condition "no selection" never arises.

**Example — Java `substring`:**
`substring(start, end)` could throw if indices are out of range, or it could clamp them to the valid range and return the best possible result. The latter defines the error out of existence (though Java chose the former).

### What to flag in a PR

- New exceptions or error codes that callers must handle, where the interface could be redefined to make the condition impossible.
- Configuration parameters where a good default exists or could be computed.
- Error handling that exists only because the interface was defined too narrowly.

---

## Comments & Obviousness

Comments exist to capture information that cannot be expressed in code: the *what* and *why* of interfaces, the rationale behind non-obvious decisions, the invariants that must hold.

### Interface comments vs. implementation comments

**Interface comments** describe what a module/function does, not how. They should let a caller use the module without reading the implementation. Good interface comments cover:
- What the function does (at a higher abstraction than the code).
- What each parameter means (not just its type — its semantics, valid ranges, edge cases).
- What side effects occur.
- What exceptions can be raised and when.

**Implementation comments** explain *why*, not *what*. If the code itself makes the *what* obvious, no implementation comment is needed. But if a block exists because of a subtle invariant, a performance concern, or a workaround for an external bug, that needs a comment.

### What to flag in a PR

- Interface-level functions with no doc comment, or doc comments that restate the code ("increments the counter" on an `increment()` method).
- Comments that describe implementation details in interface documentation — this is information leakage through documentation.
- Non-obvious code left uncommented: complex boolean expressions, surprising control flow, values chosen for non-obvious reasons.
- Comments that are *too long* for trivial code — a sign the code should be simplified rather than explained.

---

## Red Flags Quick Reference

Use this as a checklist. Only cite flags that genuinely appear in the PR.

| Red Flag | Signal |
|---|---|
| **Shallow module** | Interface ≈ as complex as implementation |
| **Information leakage** | Design decision visible in multiple modules |
| **Temporal decomposition** | Modules split by execution order, sharing data knowledge |
| **Pass-through method** | Method delegates to another with matching signature |
| **Pass-through variable** | Parameter threaded through methods that don't use it |
| **Repetition** | Same logic appears in multiple places |
| **Special-general mixture** | General-purpose mechanism contains special-case code |
| **Conjoined methods** | Can't understand one without reading the other |
| **Comment repeats code** | Comment restates what the code obviously does |
| **Implementation in interface docs** | Interface documentation exposes implementation choices |
| **Vague name** | Name broad enough to mean many things |
| **Hard to pick name** | Difficulty naming hints at unclear responsibility |
| **Hard to describe** | Difficulty writing a short comment hints at design problem |
| **Non-obvious code** | Meaning not apparent from a quick read |

---

## Tactical vs. Strategic

A PR can be **tactically correct** (it works, it passes tests) while being **strategically harmful** (it adds complexity that makes future changes harder). The purpose of structural review is to catch strategic harm before it compounds.

Ask: "If the next ten PRs follow this pattern, what does the codebase look like?" If the answer is "messier," the structure deserves attention even if the behaviour is correct.

Do **not** use this as a reason to block every PR. Most code is fine. The point is to catch the cases where a small structural change now prevents significant complexity later.
