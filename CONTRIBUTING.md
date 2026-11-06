# Contributing

Thanks for wanting to help. Pull requests are closed on this repository; issues
are open and welcome.

## Issues

Bug reports, questions and ideas all go in the issue tracker. A good bug report
names what you did, what you expected and what happened instead, with the
version from Settings > About and, where it helps, a screenshot or the server's
log lines. Search the open issues first; a thumbs-up on an existing one counts.

Describe a problem or an idea in words rather than as a patch. If an issue does
include code (a suggested fix, a snippet), you confirm you have the right to
share it and that it is not copied from another project, and you grant
Sillyanonymous a perpetual, worldwide, non-exclusive, irrevocable, royalty-free
license to use, modify and distribute it on any terms.

## Extensions are the way to change things

The extension API gives extensions the same reach as the app's own code:
events, storage, settings, windows, views, themes and providers. An extension is
your own work under whatever license you choose, it survives updates, and it
needs nobody's approval to ship. If you want the app to behave differently for
you or for others, write an extension; the extension authors' guide is the last
part of [the user guide](https://sillyanonymous.github.io/ProjectSigma/guide.html#extensions), and every
extension in `extensions/bundled/` is MIT licensed and free to copy, the sample in `extensions/bundled/hello-world/`
among them.

If the extension API cannot reach what you need, that is worth an issue too: "Asking for a new door"
in the extension authors' guide says what a request needs to get built.

## About the license

The license is deliberately narrow for now: it protects the time and work that
went into the project while it finds its feet. The intent is to loosen it in
the future. That is a statement of intent, not a promise or a date, and until it
happens the terms in [LICENSE](LICENSE) are the ones that apply.
