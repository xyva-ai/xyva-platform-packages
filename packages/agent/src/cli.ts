#!/usr/bin/env node
import chalk from 'chalk'
import { Command } from 'commander'

import { clearCredentials, loadCredentials, loginFlow } from './auth.js'
import { checkRuntime } from './bootstrap.js'
import { activateLicense, getLicenseStatus } from './license.js'
import { parseAllowedAgentPort, resolveAllowedAgentPorts } from './agent-port-policy.js'
import {
  configureProviderFromCli,
  deleteProviderFromCli,
  providerStatusesForCli,
  setFlowProviderGrantFromCli,
} from './provider-cli.js'
import { startServer } from './server.js'
import { AGENT_VERSION } from './version.js'

const program = new Command()

program
  .name('xyva-agent')
  .description('xyva.ai local test agent')
  .version(AGENT_VERSION)

const programWithMaybeHelp = program as Command & {
  showHelpAfterError?: () => Command
}

if (typeof programWithMaybeHelp.showHelpAfterError === 'function') {
  programWithMaybeHelp.showHelpAfterError()
}

program
  .command('start')
  .description('Start the local agent server')
  .option('-p, --port <port>', 'Server port', '7900')
  .option('--project <path>', 'Project directory')
  .option('--no-banner', 'Skip ASCII banner')
  .action(async (options) => {
    if (options.banner !== false) {
      printBanner()
    }

    const credentials = loadCredentials()
    if (!credentials) {
      throw new Error("Agent is not logged in. Run 'npx @xyva/agent login' first.")
    }

    console.log(chalk.dim('Checking runtime shell...'))
    await checkRuntime({
      repairPlaywright: process.env.XYVA_AGENT_SKIP_BROWSER_REPAIR !== '1',
      projectPath: options.project ? String(options.project) : undefined,
    })

    const port = parseAllowedAgentPort(String(options.port), resolveAllowedAgentPorts())

    await startServer({
      port,
      projectPath: options.project ? String(options.project) : undefined,
      credentials,
    })
  })

program
  .command('login')
  .description('Authenticate the local agent')
  .option('--token <token>', 'Manual token bootstrap for the current foundation step')
  .option('--email <email>', 'Email paired with the manual token')
  .option('--portal-url <url>', 'Portal base URL override')
  .action(async (options) => {
    printBanner()
    const credentials = await loginFlow({
      token: options.token || process.env.XYVA_AGENT_TOKEN,
      email: options.email || process.env.XYVA_AGENT_EMAIL,
      portalUrl: options.portalUrl,
    })

    try {
      await activateLicense(credentials.portalUrl, credentials.token)
    } catch (error) {
      console.log(chalk.yellow(`License activation skipped: ${(error as Error).message}`))
    }

    console.log(chalk.green(`Logged in as ${credentials.email}`))
    console.log(chalk.dim(`Portal: ${credentials.portalUrl}`))
    console.log(chalk.dim(`Expires: ${new Date(credentials.expiresAt).toISOString()}`))
  })

program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => {
    clearCredentials()
    console.log(chalk.green('Stored agent credentials removed.'))
  })

program
  .command('status')
  .description('Show agent login status')
  .action(() => {
    const credentials = loadCredentials()
    if (!credentials) {
      console.log(chalk.yellow('Not logged in'))
      return
    }

    console.log(chalk.green(`Logged in as ${credentials.email}`))
    console.log(chalk.dim(`Portal: ${credentials.portalUrl}`))
    console.log(chalk.dim(`Expires: ${new Date(credentials.expiresAt).toISOString()}`))
    const license = getLicenseStatus()
    console.log(chalk.dim(`License: ${license.allowed ? `${license.source}:${license.tier || 'active'}` : license.reason || 'not active'}`))
  })

const providerCommand = program
  .command('provider')
  .description('Configure the product-neutral local model-provider bridge')

providerCommand
  .command('status')
  .description('Show secret-free status for every supported provider')
  .option('--json', 'Print machine-readable JSON')
  .action((options) => {
    const statuses = providerStatusesForCli()
    if (options.json) {
      console.log(JSON.stringify(statuses, null, 2))
      return
    }
    for (const status of statuses) {
      const key = status.transport === 'cloud' ? (status.keyConfigured ? 'configured' : 'missing') : 'not-required'
      console.log([
        status.providerId,
        `transport=${status.transport}`,
        `selected=${status.selected ? 'yes' : 'no'}`,
        `model=${status.defaultModel || 'missing'}`,
        `key=${key}`,
        `flow=${status.flowGranted ? 'granted' : 'denied'}`,
      ].join(' '))
    }
  })

providerCommand
  .command('configure')
  .description('Select a provider and default model; cloud keys are entered through a masked TTY prompt')
  .argument('<provider>', 'ollama, lmstudio, openai, claude, or gemini')
  .requiredOption('--model <model>', 'Default model identifier')
  .option('--replace-key', 'Replace an existing cloud key through the masked prompt')
  .action(async (provider, options) => {
    const status = await configureProviderFromCli({
      providerId: provider,
      defaultModel: options.model,
      replaceKey: options.replaceKey === true,
    })
    console.log(chalk.green(`Configured ${status.providerId}.`))
    console.log(chalk.dim(`Model: ${status.defaultModel || 'missing'}`))
    console.log(chalk.dim(`Credential: ${status.transport === 'cloud' ? (status.keyConfigured ? 'configured' : 'missing') : 'not required'}`))
  })

providerCommand
  .command('delete')
  .description('Delete the local model and cloud credential for one provider')
  .argument('<provider>', 'ollama, lmstudio, openai, claude, or gemini')
  .option('--yes', 'Confirm deletion')
  .action((provider, options) => {
    const status = deleteProviderFromCli(provider, options.yes === true)
    console.log(chalk.green(`Deleted local configuration for ${status.providerId}.`))
  })

providerCommand
  .command('grant')
  .description('Explicitly allow Flow to use one configured provider')
  .argument('<provider>', 'ollama, lmstudio, openai, claude, or gemini')
  .requiredOption('--product <product>', 'Product receiving the provider grant (flow)')
  .option('--yes', 'Confirm the product grant')
  .action((provider, options) => {
    if (options.product !== 'flow') throw new Error('Invalid provider grant')
    const status = setFlowProviderGrantFromCli(provider, true, options.yes === true)
    console.log(chalk.green(`Granted ${status.providerId} to Flow.`))
  })

providerCommand
  .command('revoke')
  .description('Revoke Flow access to one provider without deleting its local configuration')
  .argument('<provider>', 'ollama, lmstudio, openai, claude, or gemini')
  .requiredOption('--product <product>', 'Product losing the provider grant (flow)')
  .option('--yes', 'Confirm the product revocation')
  .action((provider, options) => {
    if (options.product !== 'flow') throw new Error('Invalid provider grant')
    const status = setFlowProviderGrantFromCli(provider, false, options.yes === true)
    console.log(chalk.green(`Revoked ${status.providerId} from Flow.`))
  })

const argv = process.argv.length > 2 ? process.argv : [...process.argv, 'start']

program.parseAsync(argv).catch((error: unknown) => {
  console.error(chalk.red((error as Error).message || 'Agent CLI failed'))
  process.exit(1)
})

function printBanner(): void {
  console.log(chalk.bold(`
+-------------------------------------------+
|   ${chalk.cyan('xyva.ai')} Local Test Agent v${AGENT_VERSION}   |
+-------------------------------------------+
`))
}
