/*
 * Copyright 2019 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ExecType,
  CodedError,
  i18n,
  Table,
  isHeadless,
  inBrowser,
  Arguments,
  MixedResponse,
  KResponse
} from '@kui-shell/core'

import RawResponse from './response'
import commandPrefix from '../command-prefix'
import { KubeOptions, getNamespaceForArgv, getContextForArgv, fileOf } from './options'

import { FinalState } from '../../lib/model/states'
import { stringToTable, KubeTableResponse } from '../../lib/view/formatTable'

const strings = i18n('plugin-kubeui')

/** Optional argument prepartion */
export type Prepare<O extends KubeOptions> = (args: Arguments<O>) => string

/** No-op argument preparation */
export const NoPrepare = <O extends KubeOptions>(args: Arguments<O>) => args.command

/** Special case preparation for status */
export type PrepareForStatus<O extends KubeOptions> = (cmd: string, args: Arguments<O>) => string

/** Standard status preparation */
function DefaultPrepareForStatus<O extends KubeOptions>(cmd: string, args: Arguments<O>) {
  const rest = args.argvNoOptions.slice(args.argvNoOptions.indexOf(cmd) + 1).join(' ')
  const file = fileOf(args)
  return file ? `-f ${fileOf(args)} ${rest}` : rest
}

/**
 * Execute the given command in the browser; this dispatches to
 * _kubectl, which runs on the proxy (for electron and headless, these
 * are the same machine).
 *
 */
export async function doExecWithoutPty<O extends KubeOptions>(
  args: Arguments<O>,
  prepare: Prepare<O> = NoPrepare,
  exec = 'kubectl'
): Promise<RawResponse> {
  const raw = `_${exec}$1`
  const command = prepare(args)
    .replace(new RegExp(`^${exec}(\\s)?`), raw)
    .replace(/^k(\s)?/, raw)

  const dbl = new RegExp(`_${exec}(\\s)?`)
  const doubleCheck = dbl.test(command) ? command : `_${exec} ${command}`
  return args.REPL.qexec<RawResponse>(doubleCheck, undefined, undefined, args.execOptions).catch((err: CodedError) => {
    if (err.code === 500 || err.statusCode === 500) {
      err.code = err.statusCode = 500
    }
    throw err
  })
}

/**
 * Behaves as does `exec`, except that it projects out just the
 * `stdout` part -- thus ignoring the exit `code` and `stderr`.
 *
 */
export function doExecWithStdout<O extends KubeOptions>(
  args: Arguments<O>,
  prepare: Prepare<O> = NoPrepare,
  exec?: string
): Promise<string> {
  return doExecWithoutPty(args, prepare, exec).then(_ => _.content.stdout)
}

/**
 * Execute the given command using a pty
 *
 */
export async function doExecWithPty<
  Content = void,
  Response extends KResponse<Content> = KResponse<Content>,
  O extends KubeOptions = KubeOptions
>(args: Arguments<O>, prepare: Prepare<O> = NoPrepare): Promise<string | Response> {
  if (isHeadless() || (!inBrowser() && args.execOptions.raw)) {
    return doExecWithStdout(args, prepare)
  } else {
    //
    // For commands `kubectl (--help/-h)` and `k (--help/-h)`, render usage model;
    // Otherwise, execute the given command using a pty
    //
    const commandToPTY = args.command.replace(/^k(\s)/, 'kubectl$1')
    return args.REPL.qexec<string | Response>(
      `sendtopty ${commandToPTY}`,
      args.block,
      undefined,
      args.execOptions.onInit
        ? args.execOptions
        : Object.assign({}, args.execOptions, {
            rawResponse: true,
            quiet:
              args.execOptions.quiet === undefined
                ? args.execOptions.type === ExecType.TopLevel
                  ? false
                  : undefined
                : args.execOptions.quiet
          })
    ).catch((err: CodedError) => {
      if (err.code === 500 || err.statusCode === 500) {
        err.code = err.statusCode = 500
      }
      throw err
    })
  }
}

/**
 * Decide whether to use a pty or a raw exec.
 *
 */
export async function exec<O extends KubeOptions>(
  args: Arguments<O>,
  prepare: Prepare<O> = NoPrepare,
  exec = 'kubectl'
): Promise<RawResponse> {
  if (args.argvNoOptions.includes('|')) {
    return Promise.resolve({
      content: {
        code: 0,
        stdout: await doExecWithPty(args, prepare),
        stderr: '',
        wasSentToPty: true
      }
    })
  } else {
    const response = await doExecWithoutPty(args, prepare, exec)
    return response
  }
}

/**
 * Behaves as does `exec`, except that it projects out just the
 * `stdout` part and parses it into a Table model.
 *
 */
export async function doExecWithTable<O extends KubeOptions>(
  args: Arguments<O>,
  prepare: Prepare<O> = NoPrepare
): Promise<Table | MixedResponse> {
  const response = await doExecWithoutPty(args, prepare)

  const table = stringToTable(response.content.stdout, response.content.stderr, args)
  if (typeof table === 'string') {
    throw new Error(strings('Unable to parse table'))
  } else {
    return table
  }
}

/**
 * Execute a command, and then execute the status command which will
 * poll until the given FinalState is reached.
 *
 */
export const doExecWithStatus = <O extends KubeOptions>(
  cmd: string,
  finalState: FinalState,
  command = 'kubectl',
  prepareForExec: Prepare<O> = NoPrepare,
  prepareForStatus: PrepareForStatus<O> = DefaultPrepareForStatus
) => async (args: Arguments<O>): Promise<KubeTableResponse> => {
  const response = await exec<O>(args, prepareForExec, command)

  if (response.content.code !== 0) {
    const err: CodedError = new Error(response.content.stderr)
    err.code = response.content.code
    throw err
  } else if (isHeadless()) {
    return response.content.stdout
  } else {
    const contextArgs = `${getNamespaceForArgv(args)} ${getContextForArgv(args)}`
    const watchArgs = `--final-state ${finalState} --watch`

    // this helps with error reporting: if something goes wrong with
    // displaying "status", we can always report the initial response
    // from the exec command
    const errorReportingArgs = `--response "${response.content.stdout}"`

    const statusArgs = prepareForStatus(cmd, args)

    const statusCmd = `${commandPrefix} status ${statusArgs} ${watchArgs} ${contextArgs} ${errorReportingArgs}`
    return args.REPL.qexec(statusCmd, args.block)
  }
}

export default exec
