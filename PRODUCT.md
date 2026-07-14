# Open Loom - product context

**What it is.** A self-hosted, open-source screen recorder for sending walkthrough videos to
prospects and clients: your face always in the recording (corner bubble or full frame), the screen
behind it, a shareable link seconds after you stop. Loom without the subscription or the lock-in.

**Register.** product. The design serves the task; the tool must disappear while someone records
a proposal walkthrough. The overlay surfaces (launcher, HUD, bubble, countdown) float over the
user's desktop and are the brand's face - they carry the premium feel.

**Users.** Founders, freelancers and agency operators who sell by talking over their screen:
proposals, audits, project updates. They record 1-5 minute videos many times a week, often
seconds before sending a message. Zero patience for friction or jank; a cheap-looking recorder
undermines the premium service they are selling.

**Scene.** A founder at a desk mid-afternoon, browser full of a client's proposal, hits record,
talks for two minutes, stops, pastes a link into WhatsApp. Recording chrome must be glanceable
and calm; the main app is used briefly between recordings.

**Tone.** Confident, quiet, precise. Copy is short and plain-English (British). No exclamation
marks, no marketing speak inside the product.

**Brand feel.** Apple-adjacent premium: glass overlay surfaces, violet accent, smooth 150-250ms
motion, thin loading rings. Everything feels physical and finished. Never busy, never neon.

**Anti-references.** OBS (utilitarian chaos), generic Electron apps (default chrome, raw states),
neon-on-black AI slop, SaaS dashboard clichés.

**Strategic principles.**
1. No raw states, ever: a video surface, camera feed or list is designed in loading, empty,
   error and ready states, or it does not ship.
2. The recording is sacred: nothing that is not meant for the viewer may appear in a capture
   (controls are capture-excluded; the ink overlay and the face bubble are deliberately captured).
3. One-glance control: everything needed mid-recording lives on the little side panel (HUD).
4. Speed to link: every flow bends toward "stop -> shareable link in seconds".
