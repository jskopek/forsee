# Releasing Forsee

How the macOS and Windows apps are built, signed, published and updated, and the one-time set-up each part needs.

## How a release happens

1. Work is merged into `main`.
2. The **Release** workflow (`.github/workflows/release.yml`) builds the Mac app (`Forsee.dmg`, plus a `.zip` for the updater) and the Windows installer (`Forsee-Setup.exe`). It signs them if the signing secrets below are set.
3. If the version in `apps/desktop/package.json` has no tag yet (`v0.2.0`, ...), **and** `CHANGELOG.md` has an entry for it, **and** both apps are signed, the workflow publishes a GitHub Release with that tag, using the changelog entry as its release notes. Otherwise the builds are kept only as workflow artifacts (Actions → the run → Artifacts), which is how to test a change before releasing it.
4. Installed copies check GitHub Releases about ten seconds after start and every four hours. They download a new version in the background and install it when Forsee is closed. Forsee never restarts by itself, because someone may be mid-sentence. The menu has Check for Updates / Restart to Update.

**To release a new version:**

1. Run `pnpm release:version 0.2.1`. It sets the desktop and web app versions and adds a `## 0.2.1` entry at the top of `CHANGELOG.md`.
2. Replace the entry's TODO line with what changed, written for the people who use Forsee. This text is what they see as the release notes.
3. Commit and merge to `main`.

A merge that doesn't change the version only builds; it doesn't update anyone. A version without a finished changelog entry can't be released: CI (`pnpm release:check`) fails on the pull request, and the Release workflow refuses it before building.

Rules that keep updates working:

- Never change `appId` (`works.empathy.forsee`) or `productName` in `apps/desktop/electron-builder.yml`.
- Never change the artifact names `Forsee.dmg` and `Forsee-Setup.exe`: the website's download links depend on them.
- The repository must be **public**: the apps download updates from its releases without logging in.
- Don't delete a published release that people may have installed. Release a higher version instead.

## Mac signing (one-time)

You need an Apple Developer account (Account Holder or Admin role).

1. **Developer ID certificate.** On a Mac, in Xcode: Settings → Accounts → your team → Manage Certificates → + → **Developer ID Application**. (Or developer.apple.com → Certificates → + → Developer ID Application, with a request made in Keychain Access.)
2. **Export it.** Keychain Access → My Certificates → "Developer ID Application: …" → right-click → Export → `.p12`, with a strong password. Then run `base64 -i cert.p12 | pbcopy` to copy it as text.
3. **API key for notarisation.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → + (role **Developer**). Download the `.p8` file (you can only download it once) and note the **Key ID** and the **Issuer ID** shown above the list.
4. **GitHub secrets** (repository → Settings → Secrets and variables → Actions → New repository secret):

| Secret                | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `MAC_CERT_P12_BASE64` | the base64 text from step 2                                         |
| `MAC_CERT_PASSWORD`   | the `.p12` password                                                 |
| `APPLE_API_KEY_P8`    | the whole contents of the `.p8` file, including the BEGIN/END lines |
| `APPLE_API_KEY_ID`    | the Key ID                                                          |
| `APPLE_API_ISSUER`    | the Issuer ID                                                       |

Apple's first notarisation for a new account can take an hour or more. Later ones usually take minutes.

## Windows signing with SignPath Foundation (one-time)

SignPath Foundation signs open-source projects for free. The installer then shows "SignPath Foundation" as the verified publisher. Windows SmartScreen may still warn the first people who download a new app; the warning goes away as more people install it.

1. **Apply** at https://signpath.org/apply. They require:
   - an OSI licence (MIT ✓) and a public repository,
   - builds made only by CI from that repository (the Release workflow ✓),
   - a code signing policy and privacy statement on the project's website (`website/public/code-signing.html` ✓, served at `/code-signing`),
   - multi-factor authentication on the GitHub accounts of people who can merge.
2. Once accepted, in the SignPath web app:
   - Connect the GitHub repository as a **trusted build system** (GitHub.com, with the SignPath GitHub App installed on the repository).
   - Create the project with slug `forsee` and a signing policy with slug `release-signing`.
   - Create two **artifact configurations**:
     - slug `app`: a zip of the app folder; sign `Forsee.exe` and every `.dll`/`.node` inside, for example:
       ```xml
       <zip-file>
         <pe-file path="Forsee.exe"><authenticode-sign/></pe-file>
         <pe-file path="*.dll" max-matches="unbounded"><authenticode-sign/></pe-file>
         <directory path="resources"><pe-file path="**/*.node" min-matches="0" max-matches="unbounded"><authenticode-sign/></pe-file></directory>
       </zip-file>
       ```
     - slug `installer`: a zip holding `Forsee-Setup.exe`; sign it:
       ```xml
       <zip-file>
         <pe-file path="Forsee-Setup.exe"><authenticode-sign/></pe-file>
       </zip-file>
       ```
   - Create a CI user with submitter rights on the policy and copy its API token.
3. **In GitHub:** add the secret `SIGNPATH_API_TOKEN`, and under Variables add `SIGNPATH_ORGANIZATION_ID`. Also add `SIGNPATH_PROJECT_SLUG` or `SIGNPATH_POLICY_SLUG` if your slugs differ from the ones above.

SignPath Foundation's policy may require a person to approve each signing request in their web app. The workflow waits for that approval.

How the Windows job uses it: it packages the app folder, sends it to SignPath (`app`), wraps the signed app in the installer, sends the installer to SignPath (`installer`), and then `scripts/refresh-update-info.mjs` recomputes the installer's size and SHA-512 in `latest.yml` so the updater accepts the signed file.

Until SignPath is set up, the workflow builds an unsigned installer as an artifact, and no release is published.

## Website (Dokploy)

`website/` is a static site served by nginx: the home page, `/code-signing`, and two stable download links that always point to the newest release:

- `/download/mac` → `Forsee.dmg`
- `/download/windows` → `Forsee-Setup.exe`

In Dokploy: Create Application → provider GitHub, repository `jskopek/forsee`, branch `main` → Build Type **Dockerfile**, Docker file `Dockerfile`, Docker context path `website` (the folder that holds the Dockerfile) → Domains: add your domain, container port 80, HTTPS with Let's Encrypt → turn on Auto Deploy so merges to `main` update the site.

To try it locally: `docker build -t forsee-site website && docker run -p 8080:80 forsee-site`, then open http://localhost:8080.

## Before announcing a release

Nobody can test these from CI. Check them on real machines:

- [ ] Mac: download from the website, open the `.dmg`, drag Forsee to Applications, open it. There should be no warning other than "downloaded from the internet".
- [ ] Windows: download, double-click, and Forsee opens. Check the publisher shown in the file's Properties → Digital Signatures.
- [ ] Speech works on the first Speak with no click first, and a voice is listed in Settings.
- [ ] Settings and learned words are still there after quitting and reopening.
- [ ] **Updates:** with the release installed, publish the next version (for example 0.2.1). Within a few minutes of opening Forsee, Help/Forsee menu → Check for Updates says it's ready. Quit and reopen, and the new version shows in About.
