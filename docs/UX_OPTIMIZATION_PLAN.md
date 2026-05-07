# UX Optimization Plan

Source baseline:

- `C:\Users\EPEANZ\Documents\Playground\FEISHU_CODEX_CONTROL_DESIGN.md`
- Current branch implementation on `zpj/飞书控制Codex桥接`

## Goal

Turn the bridge from an engineering control surface into a personal task console that is clearer on mobile, easier to navigate, and more predictable during long-running work.

This round focuses on personal-use UX rather than team permissions.

## Problems Confirmed

1. The main control group behaves like a function menu, not a dashboard.
2. Mobile cards are too dense, and button labels are hard to identify quickly.
3. Task chats do not clearly separate stable status, current progress, and current result.
4. Model and reasoning effort defaults exist, but users cannot reliably adjust them from Feishu.
5. Finding old tasks is still weak even with dedicated task chats.
6. Main-group and child-chat visual language is too similar.
7. Final result cards are cleaner than before, but still inconsistent in rhythm and structure.

## Delivery Scope

### P0 This Round

1. Main control dashboard
   - running / pending approval / queued / completed today summary
   - recent task list
   - clearer action hierarchy
   - project quick entry

2. Task settings UX
   - task-level selected model
   - task-level selected reasoning effort
   - settings entry in waiting/running/completed task chats
   - visible current settings in task status card

3. Child chat rhythm
   - stable status card
   - current progress card
   - final result card with structured sections
   - clearer acknowledgment when a new turn starts in an existing task chat

4. Mobile card layout optimization
   - reduce command text noise on hybrid mode
   - avoid over-wide multi-button rows
   - shorten button labels to mobile-safe labels
   - move secondary actions behind separate helper cards where needed
   - improve information chunking so first screen answers:
     - what task is this
     - what state is it in
     - what should I do next

5. Task navigation
   - recent tasks
   - running tasks
   - completed tasks
   - failed/interrupted tasks

### Completed In This Round

1. Project settings card
2. Archived task center
3. Search by keyword/title/events through `/search <keyword>` and task search cards
4. Richer diagnostic recovery action through `[恢复连接]`
5. Better progress narrative copy through stable progress cards and structured final cards
6. Non-Git workspace checkpoints, `[本次影响]`, and limited safe restore for fully captured small text files
7. Optional local task detail page when HTTP mode is enabled

### Remaining Next Round

1. Project directory discovery from common local locations
2. First-run pairing/trusted device UX
3. Desktop-origin live mirror/import
4. Runtime schema validation hardening

## Interaction Principles

### Main Control Group

- button-first
- low noise
- no child-task live detail replay
- optimized for discover, create, continue, locate

### Child Task Chat

- natural-language-first
- one stable status surface
- one current-turn progress surface
- one current-turn result surface
- buttons as helpers, not the core interaction

## Mobile-Specific Rules

1. No more than 2 primary buttons in one row.
2. High-frequency actions go first.
3. Command cheat-sheet should be hidden or minimized in hybrid mode.
4. Long text must be split into titled blocks instead of one Markdown paragraph.
5. Status summary must be visible before any button grid.

## Acceptance Criteria

1. `/codex` shows a dashboard rather than only a command menu.
2. New task flow allows selecting model and reasoning effort before prompt submission.
3. Existing task chat shows current model and reasoning effort.
4. Mobile card first screen is readable without horizontal scanning pressure.
5. Running and completed tasks are easier to locate from the main control group.
6. Final result cards have stable structured sections.

## Implementation Order

1. Data support for task-level settings and task-list filtering - done
2. Main dashboard and task list cards - done
3. Waiting-task and task-settings cards - done
4. Task status/progress/result card restructuring - done
5. Mobile layout tightening - done
6. Search/detail/impact/recovery cards - done
7. Tests and verification - done locally
