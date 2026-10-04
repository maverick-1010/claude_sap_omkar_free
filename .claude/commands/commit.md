---
description: Commit changes and push to remote repository
argument-hint: [optional commit message]
---

# Commit and Push Workflow

1. Run `git status` and `git diff` to review changes

2. Analyze changes and create a Conventional Commits formatted 
   message (use $ARGUMENTS if provided)

3. Stage changes with `git add .`

4. Show me the commit message and wait for my confirmation

5. After confirmation:
   - Run `git pull --rebase origin $(git branch --show-current)` 
     to sync with remote
   - Run `git commit -m "your-message"`
   - Run `git push origin $(git branch --show-current)`

6. Show me the final result with commit hash and push confirmation

Generate the complete schema.cds file with proper syntax, indentation, 
and SAP CAP best practices.
If there are merge conflicts during pull, STOP and ask me how to proceed.