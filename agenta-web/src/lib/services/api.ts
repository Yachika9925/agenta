import useSWR from "swr"
import axios from "@/lib//helpers/axiosConfig"
import { parseOpenApiSchema } from "@/lib/helpers/openapi_parser"
import {
    Variant,
    Parameter,
    EvaluationResponseType,
    Evaluation,
    AppTemplate,
    GenericObject,
    TemplateImage,
    Environment,
    CreateCustomEvaluation,
    ExecuteCustomEvalCode,
    ListAppsItem,
    AICritiqueCreate,
} from "@/lib/Types"
import {
    fromEvaluationResponseToEvaluation,
    fromEvaluationScenarioResponseToEvaluationScenario,
} from "../transformers"
import { EvaluationFlow, EvaluationType } from "../enums"
import { delay } from "../helpers/utils"
import { useAppContext } from "@/contexts/app.context"
import { useEffect } from "react"
/**
 * Raw interface for the parameters parsed from the openapi.json
 */

const fetcher = (url: string) => axios.get(url).then((res) => res.data)

export async function fetchVariants(
    appId: string,
    ignoreAxiosError: boolean = false,
): Promise<Variant[]> {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/${appId}/variants/`,
        { _ignoreError: ignoreAxiosError } as any,
    )

    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        return response.data.map((variant: Record<string, any>) => {
            let v: Variant = {
                variantName: variant.variant_name,
                templateVariantName: variant.previous_variant_name,
                persistent: true,
                parameters: variant.parameters,
                previousVariantName: variant.previous_variant_name || null,
                variantId: variant.variant_id,
                baseId: variant.base_id,
                baseName: variant.base_name,
                configId: variant.config_id,
                configName: variant.config_name,
            }
            return v
        })
    }

    return []
}

export function restartAppVariantContainer(variantId: string) {
    return axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/containers/restart_container/`,
        { variant_id: variantId },
    )
}

/**
 * Calls the variant endpoint with the input parameters and the optional parameters and returns the response.
 * @param inputParametersDict A dictionary of the input parameters to be passed to the variant endpoint
 * @param inputParamDefinition A list of the parameters that are defined in the openapi.json (these are only part of the input params, the rest is defined by the user in the optparms)
 * @param optionalParameters The optional parameters (prompt, models, AND DICTINPUTS WHICH ARE TO BE USED TO ADD INPUTS )
 * @param URIPath
 * @returns
 */
export async function callVariant(
    inputParametersDict: Record<string, string>,
    inputParamDefinition: Parameter[],
    optionalParameters: Parameter[],
    URIPath: string,
) {
    // Separate input parameters into two dictionaries based on the 'input' property
    const mainInputParams: Record<string, string> = {} // Parameters with input = true
    const secondaryInputParams: Record<string, string> = {} // Parameters with input = false
    for (let key of Object.keys(inputParametersDict)) {
        const paramDefinition = inputParamDefinition.find((param) => param.name === key)

        // If parameter definition is found and its 'input' property is false,
        // then it goes to 'secondaryInputParams', otherwise to 'mainInputParams'
        if (paramDefinition && !paramDefinition.input) {
            secondaryInputParams[key] = inputParametersDict[key]
        } else {
            mainInputParams[key] = inputParametersDict[key]
        }
    }

    optionalParameters = optionalParameters || []

    const optParams = optionalParameters
        .filter((param) => param.default)
        .filter((param) => param.type !== "object") // remove dics from optional parameters
        .reduce((acc: any, param) => {
            acc[param.name] = param.default
            return acc
        }, {})
    const requestBody = {
        ["inputs"]: secondaryInputParams,
        ...mainInputParams,
        ...optParams,
    }

    let splittedURIPath = URIPath.split("/")
    const appContainerURIPath = await getAppContainerURL(splittedURIPath[0], splittedURIPath[1])

    return axios
        .post(
            `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/${appContainerURIPath}/generate`,
            requestBody,
        )
        .then((res) => {
            return res.data
        })
}

/**
 * Parses the openapi.json from a variant and returns the parameters as an array of objects.
 * @param app
 * @param variantName
 * @returns
 */
export const getVariantParametersFromOpenAPI = async (
    appId: string,
    variantId: string,
    ignoreAxiosError: boolean = false,
) => {
    const appContainerURIPath = await getAppContainerURL(appId, variantId)
    const url = `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/${appContainerURIPath}/openapi.json`
    const response = await axios.get(url, { _ignoreError: ignoreAxiosError } as any)
    let APIParams = parseOpenApiSchema(response.data)
    // we create a new param for DictInput that will contain the name of the inputs
    APIParams = APIParams.map((param) => {
        if (param.type === "object") {
            // if param.default is defined
            if (param?.default) {
                param.default = param.default.map((item: string) => {
                    return { name: item }
                })
            } else {
                param.default = []
            }
        }
        return param
    })
    const initOptParams = APIParams.filter((param) => !param.input) // contains the default values too!
    const inputParams = APIParams.filter((param) => param.input) // don't have input values
    return { initOptParams, inputParams }
}

// Define a type for our cache
interface Cache {
    [key: string]: string
}

// Create the cache object
const urlCache: Cache = {}

/**
 * Retries the container url for an app
 * @param {string} appId - The id of the app
 * @param {string} variantId - The id of the variant
 * @returns {Promise<string>} - Returns the URL path or an empty string
 * @throws {Error} - Throws an error if the request fails
 */
export const getAppContainerURL = async (appId: string, variantId: string): Promise<string> => {
    try {
        // Null-check for the environment variable
        if (!process.env.NEXT_PUBLIC_AGENTA_API_URL) {
            throw new Error("Environment variable NEXT_PUBLIC_AGENTA_API_URL is not set.")
        }

        const queryParam = `?app_id=${appId}&variant_id=${variantId}`
        const cacheKey = `${appId}_${variantId}`

        // Check if the URL is already cached
        if (urlCache[cacheKey]) {
            return urlCache[cacheKey]
        }

        // Retrieve container URL from backend
        const url = `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/containers/container_url/${queryParam}`
        const response = await axios.get(url)
        if (response.status === 200 && response.data && response.data.uri) {
            // Cache the URL before returning
            urlCache[cacheKey] = response.data.uri
            return response.data.uri
        } else {
            return ""
        }
    } catch (error) {
        // Forward the error so it can be handled by the calling function
        throw error
    }
}

/**
 * Saves a new variant to the database based on previous
 */
export async function saveNewVariant(
    baseId: string,
    newVariantName: string,
    newConfigName: string,
    parameters: Parameter[],
) {
    await axios.post(`${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/add/from_base/`, {
        base_id: baseId,
        new_variant_name: newVariantName,
        new_config_name: newConfigName,
        parameters: parameters.reduce((acc, param) => {
            return { ...acc, [param.name]: param.default }
        }, {}),
    })
}

export async function updateVariantParams(variantId: string, parameters: Parameter[]) {
    await axios.put(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/update_variant_parameters/`,
        {
            variant_id: variantId,
            parameters: parameters.reduce((acc, param) => {
                return { ...acc, [param.name]: param.default }
            }, {}),
        },
    )
}

export async function removeApp(appId: string) {
    await axios.delete(`${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/remove_app/`, {
        data: { app_id: appId },
    })
}

export async function removeVariant(variantId: string) {
    await axios.delete(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/remove_variant/`,
        { data: { variant_id: variantId } },
    )
}

/**
 * Loads the list of testsets
 * @returns
 */
export const useLoadTestsetsList = (appId: string) => {
    const { data, error, mutate } = useSWR(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/testsets/?app_id=${appId}`,
        fetcher,
        { revalidateOnFocus: false },
    )
    return {
        testsets: data,
        isTestsetsLoading: !error && !data,
        isTestsetsLoadingError: error,
        mutate,
    }
}

export async function createNewTestset(appId: string, testsetName: string, testsetData: any) {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/testsets/${appId}`,
        {
            name: testsetName,
            csvdata: testsetData,
        },
    )
    return response
}

export async function updateTestset(testsetId: String, testsetName: string, testsetData: any) {
    const response = await axios.put(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/testsets/${testsetId}`,
        {
            name: testsetName,
            csvdata: testsetData,
        },
    )
    return response
}

export const loadTestset = async (testsetId: string) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/testsets/${testsetId}`,
    )
    return response.data
}

export const deleteTestsets = async (ids: string[]) => {
    const response = await axios({
        method: "delete",
        url: `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/testsets/`,
        data: { testset_ids: ids },
    })
    return response.data
}

export const loadEvaluations = async (appId: string) => {
    return await axios
        .get(`${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations?app_id=${appId}`)
        .then((responseData) => {
            const evaluations = responseData.data.map((item: EvaluationResponseType) => {
                return fromEvaluationResponseToEvaluation(item)
            })

            return evaluations
        })
}

export const loadEvaluation = async (evaluationId: string) => {
    return await axios
        .get(`${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationId}`)
        .then((responseData) => {
            return fromEvaluationResponseToEvaluation(responseData.data)
        })
}

export const deleteEvaluations = async (ids: string[]) => {
    const response = await axios({
        method: "delete",
        url: `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/`,
        data: { evaluations_ids: ids },
    })
    return response.data
}

export const loadEvaluationsScenarios = async (
    evaluationTableId: string,
    evaluation: Evaluation,
) => {
    return await axios
        .get(
            `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationTableId}/evaluation_scenarios`,
        )
        .then((responseData) => {
            const evaluationsRows = responseData.data.map((item: any) => {
                return fromEvaluationScenarioResponseToEvaluationScenario(item, evaluation)
            })

            return evaluationsRows
        })
}

export const createNewEvaluation = async (
    {
        variants,
        appId,
        evaluationType,
        evaluationTypeSettings,
        inputs,
        llmAppPromptTemplate,
        selectedCustomEvaluationID,
        testsetId,
    }: {
        variants: string[]
        appId: string
        evaluationType: string
        evaluationTypeSettings: Partial<EvaluationResponseType["evaluation_type_settings"]>
        inputs: string[]
        llmAppPromptTemplate?: string
        selectedCustomEvaluationID?: string
        testsetId: string
    },
    ignoreAxiosError: boolean = false,
) => {
    const data = {
        variants, // TODO: Change to variant id
        app_id: appId,
        inputs: inputs,
        evaluation_type: evaluationType,
        evaluation_type_settings: {
            ...evaluationTypeSettings,
            custom_code_evaluation_id: selectedCustomEvaluationID,
            llm_app_prompt_template: llmAppPromptTemplate,
        },
        testset_id: testsetId,
        status: EvaluationFlow.EVALUATION_INITIALIZED,
    }

    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/`,
        data,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response.data.id
}

export const updateEvaluation = async (evaluationId: string, data: GenericObject) => {
    const response = await axios.put(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationId}`,
        data,
    )
    return response.data
}

export const updateEvaluationScenario = async (
    evaluationTableId: string,
    evaluationScenarioId: string,
    data: GenericObject,
    evaluationType: EvaluationType,
) => {
    const response = await axios.put(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationTableId}/evaluation_scenario/${evaluationScenarioId}/${evaluationType}`,
        data,
    )
    return response.data
}

export const postEvaluationScenario = async (evaluationTableId: string, data: GenericObject) => {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationTableId}/evaluation_scenario`,
        data,
    )
    return response.data
}

export const evaluateAICritiqueForEvalScenario = async (
    data: AICritiqueCreate,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/evaluation_scenario/ai_critique`,
        data,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const fetchEvaluationResults = async (evaluationId: string) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/${evaluationId}/results`,
    )
    return response.data
}

export const fetchEvaluationScenarioResults = async (evaluation_scenario_id: string) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/evaluation_scenario/${evaluation_scenario_id}/score`,
    )
    return response
}

export const saveCustomCodeEvaluation = async (
    payload: CreateCustomEvaluation,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/custom_evaluation/`,
        payload,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const fetchCustomEvaluations = async (app_id: string, ignoreAxiosError: boolean = false) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/custom_evaluation/list/${app_id}`,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const fetchCustomEvaluationDetail = async (
    id: string,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/custom_evaluation/${id}`,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response.data
}

export const fetchCustomEvaluationNames = async (
    app_id: string,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/custom_evaluation/${app_id}/names/`,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const executeCustomEvaluationCode = async (
    payload: ExecuteCustomEvalCode,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/custom_evaluation/execute/${payload.evaluation_id}/`,
        payload,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const updateEvaluationScenarioScore = async (
    evaluation_scenario_id: string,
    score: number,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.put(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/evaluations/evaluation_scenario/${evaluation_scenario_id}/score`,
        { score: score },
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const useApps = () => {
    const { data, error, isLoading } = useSWR(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/list_apps/`,
        fetcher,
    )

    const { setApps } = useAppContext()

    useEffect(() => {
        setApps(data)
    }, [data])

    return {
        data: data as ListAppsItem[],
        error,
        isLoading,
    }
}

export const getTemplates = async () => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/containers/templates/`,
    )
    return response.data
}

export const pullTemplateImage = async (image_name: string, ignoreAxiosError: boolean = false) => {
    const response = await axios.get(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/containers/templates/${image_name}/images/`,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response.data
}

export const createAppFromTemplate = async (
    templateObj: AppTemplate,
    ignoreAxiosError: boolean = false,
) => {
    const response = await axios.post(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/app_variant/add/from_template/`,
        templateObj,
        { _ignoreError: ignoreAxiosError } as any,
    )
    return response
}

export const fetchData = async (url: string): Promise<any> => {
    const response = await fetch(url)
    return response.json()
}

export const waitForAppToStart = async (
    appId: string,
    timeout: number = 20000,
    interval: number = 2000,
) => {
    const variant = await fetchVariants(appId, true)
    if (variant.length) {
        const shortPoll = async () => {
            let started = false
            while (!started) {
                try {
                    await getVariantParametersFromOpenAPI(appId, variant[0].variantId, true)
                    started = true
                } catch { }
                await delay(interval)
            }
        }
        await Promise.race([
            shortPoll(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
        ])
    }
}

export const createAndStartTemplate = async ({
    appName,
    openAIKey,
    imageName,
    onStatusChange,
}: {
    appName: string
    openAIKey: string
    imageName: string
    onStatusChange?: (
        status:
            | "fetching_image"
            | "creating_app"
            | "starting_app"
            | "success"
            | "bad_request"
            | "timeout"
            | "error",
        details?: any,
    ) => void
}) => {
    try {
        onStatusChange?.("fetching_image")
        const data: TemplateImage = await pullTemplateImage(imageName, true)
        if (data.message) throw data.message

        onStatusChange?.("creating_app")
        let app
        try {
            app = await createAppFromTemplate(
                {
                    app_name: appName,
                    image_id: data.image_id,
                    image_tag: data.image_tag,
                    env_vars: {
                        OPENAI_API_KEY: openAIKey,
                    },
                },
                true,
            )
        } catch (error: any) {
            if (error?.response?.status === 400) {
                onStatusChange?.("bad_request", error)
                return
            }
            throw error
        }

        onStatusChange?.("starting_app")
        try {
            await waitForAppToStart(app.data.app_id)
        } catch (error: any) {
            if (error.message === "timeout") {
                onStatusChange?.("timeout")
                return
            }
            throw error
        }

        onStatusChange?.("success")
    } catch (error) {
        onStatusChange?.("error", error)
    }
}

export const fetchEnvironments = async (appId: string): Promise<Environment[]> => {
    const response = await fetch(
        `${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/environments/?app_id=${appId}`,
    )

    if (response.status !== 200) {
        throw new Error("Failed to fetch environments")
    }

    const data: Environment[] = await response.json()
    return data
}

export const publishVariant = async (variantId: string, environmentName: string) => {
    await axios.post(`${process.env.NEXT_PUBLIC_AGENTA_API_URL}/api/environments/deploy/`, {
        environment_name: environmentName,
        variant_id: variantId,
    })
}
