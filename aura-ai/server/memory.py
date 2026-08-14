"""Long-term facts Aura remembers about you, independent of conversation history.

Conversation history is a rolling window (the last ~12 exchanges), so anything said
earlier — your name, what you do, what you like — silently falls off. Facts stored here
never expire and are injected into every system prompt, so they survive restarts, the
"forget everything" button, and any number of conversations.

Aura writes to this itself via the remember_fact tool in brain.py; it's plain JSON, so
you can also read, edit, or delete it by hand.
"""

import json
import os
from pathlib import Path

MEMORY_FILE = Path(__file__).resolve().parent / os.getenv(
    "AURA_MEMORY_FILE", "user_memory.json"
)

MAX_FACTS = 40
MAX_FACT_LENGTH = 200


def load_facts() -> list[str]:
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [str(x) for x in data if str(x).strip()]
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return []


def save_facts(facts: list[str]) -> None:
    try:
        with open(MEMORY_FILE, "w", encoding="utf-8") as f:
            json.dump(facts, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        print(f"[aura] couldn't save memory: {exc}")


def add_fact(fact: str) -> str:
    """Stores one durable fact. Returns a short status for the model to see."""
    fact = (fact or "").strip()
    if not fact:
        return "nothing to remember"
    if len(fact) > MAX_FACT_LENGTH:
        fact = fact[:MAX_FACT_LENGTH].rstrip() + "…"

    facts = load_facts()
    if any(fact.lower() == existing.lower() for existing in facts):
        return "already remembered"

    facts.append(fact)
    # Keep the newest if we ever hit the cap, so memory can't grow without bound.
    if len(facts) > MAX_FACTS:
        facts = facts[-MAX_FACTS:]
    save_facts(facts)
    print(f"[aura] remembered: {fact}")
    return "remembered"


def forget_all() -> str:
    save_facts([])
    print("[aura] cleared all remembered facts")
    return "forgotten"


def facts_prompt_block() -> str:
    """The block appended to the system prompt, or empty if nothing is known yet."""
    facts = load_facts()
    if not facts:
        return ""
    lines = "\n".join(f"- {f}" for f in facts)
    return (
        "\n\nThings you already know about the person you're talking to "
        "(remember these; don't re-ask):\n" + lines
    )


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "remember_fact",
            "description": (
                "Save a durable fact about the user so it's remembered in future "
                "conversations — their name, preferences, relationships, job, ongoing "
                "projects, etc. Use it whenever they share something personal worth "
                "keeping. Do NOT use it for passing chit-chat or one-off questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description": (
                            "The fact, written as a short standalone statement, "
                            'e.g. "Their name is Carl" or "They have a dog called Bo".'
                        ),
                    }
                },
                "required": ["fact"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forget_everything_about_me",
            "description": (
                "Erase all stored facts about the user. Only use it when they clearly "
                "ask you to forget what you know about them."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def run_tool(name: str, arguments: str) -> str:
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        args = {}
    if name == "remember_fact":
        return add_fact(args.get("fact", ""))
    if name == "forget_everything_about_me":
        return forget_all()
    return "unknown tool"
