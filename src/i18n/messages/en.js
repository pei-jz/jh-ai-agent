// English catalog.
//
// Kept key-for-key with ja.js — a test asserts the two have identical key sets and
// identical placeholders, because a catalog that silently drops a {version} produces
// a sentence with a hole in it rather than a visible failure.
//
// These are translations of the Japanese originals, not paraphrases: where the
// Japanese deliberately promises something (that expired licences keep your files
// openable, that a failed update check is not "up to date"), the English says the
// same thing. Softening it in one language would make the two builds disagree about
// what the product does.
export const en = {
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.apply': 'Apply',
    'common.back': 'Back',
    'common.next': 'Next',
    'common.done': 'Done',
    'common.unknown': 'Unknown',
    'common.language': 'Display language',
    'common.language.hint': "The app's own language. The language the AI replies in is set separately, under Agent Behavior.",

    'update.checking': 'Checking for updates…',
    'update.available': 'Version {version} is available',
    'update.downloading': 'Downloading… {percent}%',
    'update.downloading.detail': 'The app will restart when this finishes.',
    'update.ready': 'Version {version} is ready to install',
    'update.ready.detail': 'Restarting completes the update.',
    'update.current': 'You are on the latest version',
    'update.failed': 'Could not check for updates',
    'update.failed.detail': 'The network or the release host is unreachable.',
    'update.unconfigured': 'Automatic updates are not configured',
    'update.unconfigured.detail': 'This build has no signing key, so updates cannot be checked.',
    'update.install': 'Update',
    'update.disable': "Don't check again",
    'update.section': 'Updates — version and update check',
    'update.currentVersion': 'Current version: {version}',
    'update.check': 'Check for updates',
    'update.signed.hint': 'Updates are verified against our signature before installing. Anything that fails verification is discarded.',

    'license.section': 'License — edition and key',
    'license.key': 'License key',
    'license.licensee': 'Licensed to',
    'license.offline.hint': 'The key is stored on this machine only and is never transmitted — verification is offline.',
    'license.clear': 'Remove the stored key',
    'license.community': 'Community edition',
    'license.community.detail': 'All core features are available.',
    'license.active': '{edition} license (active)',
    'license.active.perpetual': 'No expiry (perpetual)',
    'license.active.expires': 'Expires: {date}',
    'license.active.expiring': 'Expires on {date} — {days} days left.',
    'license.grace': '{edition} license (expired — in grace period)',
    'license.grace.detail': 'Expired on {date}. Everything keeps working for another {days} days. Please consider renewing.',
    'license.expired': 'Your license has expired',
    'license.expired.detail': 'Expired on {date}. You can keep using the Community features — your data and the files you created still open.',
    'license.invalid': 'Could not verify that license key',
    'license.invalid.detail': "The signature does not match. If re-pasting the key doesn't help, please contact whoever issued it.",
    'license.unconfigured.hint': 'This build carries no license-issuing key, so keys cannot be applied. Everything is available as Community.',

    'onboarding.title': 'Welcome to J.H AI Agent',
    'onboarding.aria': 'First-run setup',
    'onboarding.skip': 'Set this up later',
    'onboarding.step.connect': 'Connect an AI model',
    'onboarding.step.connect.blurb': 'The one setting the agent cannot run without. A cloud API key or something local like Ollama both work.',
    'onboarding.step.workspace': 'Choose a workspace',
    'onboarding.step.workspace.blurb': 'The folder the agent reads and writes. You can add more later, and chat or research work without one.',
    'onboarding.step.ready': 'Ready to go',
    'onboarding.step.ready.blurb': 'A few things you can do. Everything here can be changed later in Settings.',
    'onboarding.provider': 'Provider',
    'onboarding.model': 'Model',
    'onboarding.apiKey': 'API key',
    'onboarding.keyless.hint': 'Runs locally, so no API key is needed. Start Ollama first.',
    'onboarding.test': 'Test connection',
    'onboarding.noWorkspace': 'None yet. Chat and research work fine without one.',
    'onboarding.rerun': 'Run first-time setup again',
    'onboarding.rerun.hint': 'Reconfigure your connection and workspace in three steps.',
    'onboarding.open': 'Open',
};
