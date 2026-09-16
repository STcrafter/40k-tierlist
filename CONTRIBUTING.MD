# Contributing to 40k Tier List

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm run test`
5. Commit: `git commit -m "feat: add new feature"`
6. Push: `git push origin feature/my-feature`
7. Open a Pull Request

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `refactor:` — Code refactoring
- `test:` — Adding tests
- `chore:` — Maintenance

## Code Style

- Use TypeScript strict mode
- Follow ESLint rules
- Use Prettier formatting
- Write JSDoc comments for public functions

## Data Updates

When updating Wahapedia data:

1. Place new CSV files in `public/data/wahapedia/`
2. Run `npm run dev` and verify data loads correctly
3. Check that tier assignments remain reasonable

## Reporting Issues

- Use the bug report template
- Include faction, unit, and edition info
- Add screenshots if possible