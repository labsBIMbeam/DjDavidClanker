# Scratch lab

Drop audio files in this folder. Run `npm run dev`, open the **✳ Lab** tab in
the browser panel, and they appear as a category of their own.

Files here are served same-origin by the dev server, so they get decoded into
buffers — which is what the platter, EQ, FX and autoscratch all need. A plain
`npm run dev` cannot do that with streamed Wavlake tracks, so this folder is
the quickest way to have something scratchable on a deck.

Supported: `.mp3 .wav .flac .ogg .oga .opus .m4a .aac .aif .aiff`

Name files `Artist - Title.mp3` and the deck picks up both fields.

Nothing here is committed (see `.gitignore`) and nothing here reaches the
napplet build — `dev/scratch-lab.mjs` is a `apply: 'serve'` plugin.

## For working on the scratch routines

The routines are built around the turntablist convention: a short sample,
cued at its transient, cut up in place. A one- to two-second vocal or horn
stab works far better than a full song. Press **CUE** on the first transient,
then **AUTO ✳** — every routine scratches around the cue point.
