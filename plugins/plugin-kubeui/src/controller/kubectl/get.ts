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
import { v4 as uuidgen } from 'uuid'
import stripClean = require('strip-ansi')

import Commands, { Arguments, Registrar } from '@kui-shell/core/api/commands'
import { CodedError } from '@kui-shell/core/api/errors'
import { Watchable } from '@kui-shell/core/api/models'
import { Table, Row } from '@kui-shell/core/api/table-models'
import { WatchableJob } from '@kui-shell/core/core/job'

import { getSessionForTab } from '@kui-shell/plugin-bash-like'

import flags from './flags'
import { exec } from './exec'
import { RawResponse } from './response'
import commandPrefix from '../command-prefix'
import extractAppAndName from '../../lib/util/name'
import { KubeResource } from '../../lib/model/resource'
import { KubeOptions, isEntityRequest, isTableRequest, formatOf, isWatchRequest, isTableWatchRequest } from './options'
import { stringToTable, KubeTableResponse, isKubeTableResponse, jsonToTable } from '../../lib/view/formatTable'

/**
 * For now, we handle watch ourselves, so strip these options off the command line
 *
 */
function prepareArgsForGet(args: Arguments<KubeOptions>) {
  const stripThese = ['-w=true', '--watch=true', '--watch-only=true', '-w', '--watch', '--watch-only']

  const idx = args.command.indexOf(' get ') + ' get '.length
  const pre = args.command.slice(0, idx - 1)
  const post = args.command.slice(idx - 1)
  return pre + stripThese.reduce((cmd, strip) => cmd.replace(new RegExp(`(\\s)${strip}`), '$1'), post)
}

/**
 * register a watchable job
 *
 */
const registerWatcher = (
  rowKey: string,
  refreshCommand: string,
  offline: (rowKey: string) => void,
  pendingPollers: Record<string, boolean>,
  args: Commands.Arguments<KubeOptions>,
  watchLimit = 100000
) => {
  let job: WatchableJob // eslint-disable-line prefer-const

  // execute the refresh command and apply the result
  const refreshTable = async () => {
    console.error(`refresh with ${refreshCommand}`)
    try {
      await args.REPL.qexec<Table>(refreshCommand)
    } catch (err) {
      if (err.code === 404) {
        offline(rowKey)
        job.abort()
        delete pendingPollers[rowKey]
      } else {
        job.abort()
        throw err
      }
    }
  }

  // timer handler
  const watchIt = () => {
    if (--watchLimit < 0) {
      console.error('watchLimit exceeded')
      job.abort()
    } else {
      try {
        Promise.resolve(refreshTable())
      } catch (err) {
        console.error('Error refreshing table', err)
        job.abort()
      }
    }
  }

  // establish the inital watchable job
  job = new WatchableJob(args.tab, watchIt, 500 + ~~(100 * Math.random()))
  job.start()
}

function mkGenerator(uuid: string, channel, cb) {
  let escaping = false
  let inQuotes = false
  let depth = 0
  let bundle = ''

  channel.on('message', _data => {
    const response: { uuid: string; data: string; type: string } = JSON.parse(_data.toString())
    const data = stripClean(response.data)
    if (response.uuid === uuid && response.type === 'data' && response.data) {
      for (let idx = 0; idx < data.length; idx++) {
        const ch = data.charAt(idx)
        const escaped = escaping
        escaping = false
        bundle += ch
        if (!inQuotes && ch === '{') {
          depth++
        }
        if (!escaped && ch === '"') {
          inQuotes = !inQuotes
        }
        if (!escaped && ch === '\\') {
          escaping = true
        }
        if (!inQuotes && ch === '}') {
          if (--depth === 0) {
            cb(JSON.parse(bundle))
            bundle = ''
          }
        }
      }
    }
  })
}

function doWatch(
  args: Arguments<KubeOptions>,
  command: string,
  verb: string,
  entityType: string,
  watchfromEmptyTable?: boolean
): Watchable {
  return {
    watch: {
      init: async (update: (response: Row) => void, offline: (rowKey: string) => void) => {
        const channel = await getSessionForTab(args.tab)
        const uuid = uuidgen()
        const watchCmd = args.command
          .replace(/^k(\s)/, 'kubectl$1')
          .replace(/--watch=true|-w=true|--watch|-w/g, '--watch-only')

        const watchWithJson = `${watchCmd} -o json`

        const msg = {
          type: 'exec',
          cmdline: watchWithJson,
          uuid,
          cwd: process.env.PWD
        }

        console.error('delegating to websocket channel', msg)

        channel.send(JSON.stringify(msg))

        const pendingPollers: Record<string, boolean> = {}
        mkGenerator(uuid, channel, async (kubeResource: KubeResource) => {
          const table = jsonToTable(kubeResource, args, command, verb, entityType)
          const row = table.body[0]

          if (watchfromEmptyTable) {
            update(table.header)
            watchfromEmptyTable = false
          }

          update(row)

          // poll for the terminator
          if (
            row.attributes.some(_ => _.value === 'Terminating') &&
            (!pendingPollers || !pendingPollers[row.name]) &&
            row.onclick !== false
          ) {
            pendingPollers[row.name] = true
            registerWatcher(row.name, row.onclick, offline, pendingPollers, args)
          }
        })
      }
    }
  }
}

/**
 * kubectl get as table response
 *
 */
function doGetTable(args: Arguments<KubeOptions>, response: RawResponse): KubeTableResponse {
  const {
    content: { stderr, stdout }
  } = response

  const command = 'kubectl'
  const verb = 'get'
  const entityType = args.argvNoOptions[args.argvNoOptions.indexOf(verb) + 1]

  const table = stringToTable(stdout, stderr, args, command, verb, entityType)

  if (isWatchRequest(args) && typeof table !== 'string') {
    const watch = doWatch(args, command, verb, entityType)
    return Object.assign({}, table, watch)
  }

  return table
}

/**
 * Special case: user requested a watchable table, and there is
 * nothing yet to display
 *
 */
function doGetEmptyTable(args: Arguments<KubeOptions>): KubeTableResponse {
  const entityType = args.argvNoOptions[args.argvNoOptions.indexOf('get') + 1]
  const emptyTable: Table = { body: [] }
  const watch = doWatch(args, 'kubectl', 'get', entityType, true)
  return Object.assign({}, emptyTable, watch)
}

/**
 * kubectl get as entity response
 *
 */
export async function doGetEntity(args: Arguments<KubeOptions>, response: RawResponse): Promise<KubeResource> {
  try {
    // this is the raw data string we get from `kubectl`
    const data = response.content.stdout

    // parse the raw response; the parser we use depends on whether
    // the user asked for JSON or for YAML
    const resource = formatOf(args) === 'json' ? JSON.parse(data) : (await import('js-yaml')).safeLoad(data)

    // attempt to separate out the app and generated parts of the resource name
    const { name: prettyName, nameHash } = extractAppAndName(resource)

    return Object.assign(resource, {
      prettyName,
      nameHash,
      originatingCommand: args.command,
      modes: [], // this tells Kui that we want the response to be interpreted as a MultiModalResponse
      data // also include the raw, uninterpreted data string we got back
    })
  } catch (err) {
    console.error('error handling entity response; raw=', response.content.stdout)
    throw err
  }
}

/**
 * kubectl get as custom response
 *
 */
async function doGetCustom(args: Arguments<KubeOptions>, response: RawResponse): Promise<string> {
  return response.content.stdout
}

/**
 * This is the main handler for `kubectl get`. Here, we act as a
 * dispatcher: in `kubectl` a `get` can mean either get-as-table,
 * get-as-entity, or get-as-custom, depending on the `-o` flag.
 *
 */
async function doGet(args: Arguments<KubeOptions>): Promise<string | KubeResource | KubeTableResponse> {
  // first, we do the raw exec of the given command
  const response = await exec(args, prepareArgsForGet).catch((err: CodedError) => {
    if (err.statusCode === 0 && err.code === 404 && isTableWatchRequest(args)) {
      // Notes:
      // err.statusCode === 0 means this was "normal error" (i.e. kubectl didn't bail)
      // err.code === 404 means that raw.ts thinks this error was "not found" related
      // if those hold, and the user asked us to watch a table, then
      // respond with an empty table, rather than with the error
      return doGetEmptyTable(args)
    } else {
      // Notes: we are using statusCode internally to this plugin;
      // delete it before rethrowing the error, because the core would
      // otherwise interpret the statusCode as being meaningful to the
      // outside world
      delete err.statusCode
      throw err
    }
  })

  if (isKubeTableResponse(response)) {
    return response
  } else if (response.content.code !== 0) {
    // raw exec yielded an error!
    if (isTableWatchRequest(args)) {
      // special case: user requested a watchable table, and there is
      // not yet anything to display
      return doGetEmptyTable(args)
    } else {
      const err: CodedError = new Error(response.content.stderr)
      err.code = response.content.code
      throw err
    }
  } else if (response.content.wasSentToPty) {
    return response.content.stdout
  } else if (isEntityRequest(args)) {
    // case 1: get-as-entity
    return doGetEntity(args, response)
  } else if (isTableRequest(args)) {
    // case 2: get-as-table
    return doGetTable(args, response)
  } else {
    // case 3: get-as-custom
    return doGetCustom(args, response)
  }
}

export default (commandTree: Registrar) => {
  commandTree.listen(`/${commandPrefix}/kubectl/get`, doGet, flags)
  commandTree.listen(`/${commandPrefix}/k/get`, doGet, flags)
}
