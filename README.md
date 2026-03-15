# yt-xd

Adobe XD panel + local Node uploader for the Advanced Physics thumbnail workflow:

1. Open `ap.xd` in Adobe XD.
2. Paste a YouTube video URL from the Advanced Physics channel.
3. Split the title into `Course Name - Lesson Title`.
4. Reuse the matching course artboard or duplicate a fallback artboard if the course does not exist yet.
5. Fit the green lesson text so it stays inside the layout.
6. Export the PNG, save it to `C:\Personal Projects\ap`, and upload it with YouTube's `thumbnails.set` API.

## What is in this repo

- `ap-manifest.json`
  Root-level Adobe XD UXP manifest for the Advanced Physics panel.
- `xd-plugin/ap-thumbnail-panel.js`
  Adobe XD panel logic.
- `server/advanced-physics-uploader.js`
  Local OAuth + YouTube upload service.
- `.env.example`
  Required Google OAuth configuration.

## Setup

1. Enable `YouTube Data API v3` in a Google Cloud project.
2. Create an OAuth client with redirect URI `http://127.0.0.1:4318/auth/callback`.
3. Copy `.env.example` to `.env` and fill in:
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `SESSION_SECRET`
   - Adjust `OUTPUT_DIRECTORY` if you want thumbnails saved somewhere other than `C:\Personal Projects\ap`
4. Start the local uploader:

```bash
npm start
```

5. Open Adobe XD and add the plugin via UXP Developer Tool using [ap-manifest.json](C:\Personal Projects\yt-xd\ap-manifest.json).
6. Open [ap.xd](C:\Personal Projects\yt-xd\ap.xd) in Adobe XD.

## Using the panel

- Make sure Adobe XD is not drilled into a group or layer. The plugin needs the full document edit context so it can inspect every artboard.
- Click `Check Uploader`.
- Click `Connect YouTube` once to complete OAuth in your browser.
- Paste a YouTube video URL or video ID into the panel.
- Click `Resolve Video` if you want to preview the parsed course/lesson split.
- Click `Update Thumbnail` to fetch the latest title, match the course artboard, fit the lesson title, save the PNG to `C:\Personal Projects\ap`, and upload that PNG as the video thumbnail.

## Notes

- This is not a headless Adobe XD renderer. The `.xd` document still needs to be open in Adobe XD.
- The panel uses Adobe XD's built-in UXP APIs. There is no separate Adobe XD npm SDK to install.
- Existing artboards are matched by the largest white course-title text on the artboard, not by the generic artboard names in the file.
- If a course artboard does not exist yet, the plugin duplicates a fallback artboard and updates the white course title before exporting.
- YouTube rejects thumbnails over 2 MB. If your export is too large, add `sharp` later and compress before upload.
- The OAuth refresh token is stored locally at `server/.data/youtube-tokens.json`.

## Verify the scaffold

```bash
npm run check
```
