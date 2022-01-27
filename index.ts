import { createBuffer } from '@posthog/plugin-contrib'
import { Plugin, PluginMeta, PluginEvent } from '@posthog/plugin-scaffold'
import { Client, QueryResult, Pool } from 'pg'

type PostgresPlugin = Plugin<{
    global: {
        pgClient: Client
        eventsToIgnore: Set<string>
        sanitizedTableName: string
        limitDate: Date
    }
    config: {
        databaseUrl: string
        host: string
        port: string
        dbName: string
        tableName: string
        dbUsername: string
        dbPassword: string
        hasSelfSignedCert: 'Yes' | 'No'
        teamId: string
    }
}>

type PostgresMeta = PluginMeta<PostgresPlugin>

interface ParsedEvent {
    uuid?: string
    eventName: string
    properties: string
    elements: string
    set: string
    set_once: string
    distinct_id: string
    team_id: number
    ip: string | null
    site_url: string
    timestamp: string
}


interface ImportEventsJobPayload {
    dateFrom: string
    dateTo: string
}


export const jobs: PostgresPlugin['jobs'] = {
    'Import events': async ({ dateFrom, dateTo }: ImportEventsJobPayload, { storage, jobs, global, cache }) => {
        await cache.set('max', new Date(dateTo).getTime())
        await jobs['importEvents']({
            dateFrom: new Date(dateFrom),
            dateTo: new Date(new Date(dateFrom).getTime() + 60 * 1000)
        }).runNow()
    },
    importEvents: async ({ dateFrom, dateTo }, { config, global, jobs, cache }) => {
        dateFrom = new Date(dateFrom)
        dateTo = new Date(dateTo)
        const limitDate = await cache.get('max')
        if (dateFrom.getTime() > Number(limitDate)) {
            console.log('done, exiting')
            return
        }

        const events = (await executeQuery(
            `SELECT * FROM posthog_event WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3 AND event='$pageview'`,
            [Number(config.teamId), dateFrom.toISOString(), dateTo.toISOString()],
            global
        )).rows

        for (const event of events) {
            posthog.capture(event.event, { ...event.properties, distinctId: event.distinct_id })
        }

        const newDateFrom = new Date(dateFrom.getTime() + 60 * 1000)
        const newDateTo = new Date(dateTo.getTime() + 60 * 1000)

        await jobs['importEvents']({
            dateFrom: newDateFrom,
            dateTo: newDateTo
        }).runNow()

    }
}

export const setupPlugin: PostgresPlugin['setupPlugin'] = async (meta) => {
    const { global, config } = meta

    if (!config.databaseUrl) {
        const requiredConfigOptions = ['host', 'port', 'dbName', 'dbUsername', 'dbPassword']
        for (const option of requiredConfigOptions) {
            if (!(option in config)) {
                throw new Error(`Required config option ${option} is missing!`)
            }
        }
    }
    const basicConnectionOptions = config.databaseUrl
        ? {
              connectionString: config.databaseUrl,
          }
        : {
              user: config.dbUsername,
              password: config.dbPassword,
              host: config.host,
              database: config.dbName,
              port: parseInt(config.port),
          }
    global.pgPool = new Pool({
        ...basicConnectionOptions,
        ssl: {
            rejectUnauthorized: config.hasSelfSignedCert === 'No',
        },
    })

}

const executeQuery = async (query: string, values: any[], global: PostgresMeta['global']): Promise<Error | QueryResult> => {
    // const basicConnectionOptions = config.databaseUrl
    //     ? {
    //           connectionString: config.databaseUrl,
    //       }
    //     : {
    //           user: config.dbUsername,
    //           password: config.dbPassword,
    //           host: config.host,
    //           database: config.dbName,
    //           port: parseInt(config.port),
    //       }
    // const pgClient = new Client({
    //     ...basicConnectionOptions,
    //     ssl: {
    //         rejectUnauthorized: config.hasSelfSignedCert === 'No',
    //     },
    // })

    // await pgClient.connect()

    let error: Error | null = null
    try {
        return await global.pgPool.query(query, values)
    } catch (err) {
        error = err as Error
    }

    // await pgClient.end()

    return error
}

