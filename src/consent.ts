import * as vscode from 'vscode';
import { showConsentDetails } from './ui/consentWebview';

const CONSENT_KEY = 'promptster.consentAcknowledged';

/**
 * Shows a consent notification before any telemetry capture begins.
 * Returns true if the candidate acknowledges, false if they dismiss.
 */
export async function ensureConsent(context: vscode.ExtensionContext): Promise<boolean> {
  // Check if already acknowledged in this workspace
  if (context.globalState.get<boolean>(CONSENT_KEY)) {
    return true;
  }

  const choice = await vscode.window.showInformationMessage(
    'Promptster Assessment Active — This extension captures your development process ' +
    '(file navigation, edit patterns, terminal commands) for assessment evaluation. ' +
    'No file contents or code are captured.',
    { modal: true },
    'I Understand',
    'View Details',
  );

  if (choice === 'View Details') {
    showConsentDetails(context);
    // After viewing details, ask again
    const secondChoice = await vscode.window.showInformationMessage(
      'Do you acknowledge that Promptster will capture development process signals?',
      { modal: true },
      'I Understand',
    );
    if (secondChoice !== 'I Understand') return false;
  } else if (choice !== 'I Understand') {
    return false;
  }

  await context.globalState.update(CONSENT_KEY, true);
  return true;
}
