import * as path from "path";
import * as tl from "vsts-task-lib/task";
import {IExecOptions, IExecSyncResult} from "vsts-task-lib/toolrunner";

import * as auth from "nuget-task-common/Authentication";
import { IPackageSource } from "nuget-task-common/Authentication";
import * as commandHelper from "nuget-task-common/CommandHelper";
import locationHelpers = require("nuget-task-common/LocationHelpers");
import {NuGetConfigHelper2} from "nuget-task-common/NuGetConfigHelper2";
import * as ngToolRunner from "nuget-task-common/NuGetToolRunner2";
import peParser = require("nuget-task-common/pe-parser/index");
import {VersionInfo} from "nuget-task-common/pe-parser/VersionResource";
import * as nutil from "nuget-task-common/Utility";
import * as pkgLocationUtils from "utility-common/packaging/locationUtilities";
import * as telemetry from "utility-common/telemetry";
import INuGetCommandOptions from "./Common/INuGetCommandOptions";
import * as vsts from "vso-node-api/WebApi";
import * as vsom from 'vso-node-api/VsoClient';

class RestoreOptions implements INuGetCommandOptions {
    constructor(
        public nuGetPath: string,
        public configFile: string,
        public noCache: boolean,
        public disableParallelProcessing: boolean,
        public verbosity: string,
        public packagesDirectory: string,
        public environment: ngToolRunner.NuGetEnvironmentSettings,
        public authInfo: auth.NuGetExtendedAuthInfo,
    ) { }
}

export async function run(nuGetPath: string): Promise<void> {
    let packagingLocation: pkgLocationUtils.PackagingLocation;
    try {
        packagingLocation = await pkgLocationUtils.getPackagingUris(pkgLocationUtils.ProtocolType.NuGet);
    } catch (error) {
        tl.debug("Unable to get packaging URIs, using default collection URI");
        tl.debug(JSON.stringify(error));
        const collectionUrl = tl.getVariable("System.TeamFoundationCollectionUri");
        packagingLocation = {
            PackagingUris: [collectionUrl],
            DefaultPackagingUri: collectionUrl};
    }

    const buildIdentityDisplayName: string = null;
    const buildIdentityAccount: string = null;

    try {
        nutil.setConsoleCodePage();

        // Reading inputs
        const solutionPattern = tl.getPathInput("solution", true, false);
        const useLegacyFind: boolean = tl.getVariable("NuGet.UseLegacyFindFiles") === "true";
        let filesList: string[] = [];
        if (!useLegacyFind) {
            const findOptions: tl.FindOptions = <tl.FindOptions>{};
            const matchOptions: tl.MatchOptions = <tl.MatchOptions>{};
            const searchPatterns: string[] = nutil.getPatternsArrayFromInput(solutionPattern);
            filesList = tl.findMatch(undefined, searchPatterns, findOptions, matchOptions);
        }
        else {
            filesList = nutil.resolveFilterSpec(
                solutionPattern,
                tl.getVariable("System.DefaultWorkingDirectory") || process.cwd());
        }
        filesList.forEach((solutionFile) => {
            if (!tl.stats(solutionFile).isFile()) {
                throw new Error(tl.loc("NotARegularFile", solutionFile));
            }
        });
        const noCache = tl.getBoolInput("noCache");
        const disableParallelProcessing = tl.getBoolInput("disableParallelProcessing");
        const verbosity = tl.getInput("verbosityRestore");
        let packagesDirectory = tl.getPathInput("packagesDirectory");
        if (!tl.filePathSupplied("packagesDirectory")) {
            packagesDirectory = null;
        }

        const nuGetVersion: VersionInfo = await peParser.getFileVersionInfoAsync(nuGetPath);

        // Discovering NuGet quirks based on the version
        tl.debug("Getting NuGet quirks");
        const quirks = await ngToolRunner.getNuGetQuirksAsync(nuGetPath);
        let credProviderPath = nutil.locateCredentialProvider();
        // Clauses ordered in this way to avoid short-circuit evaluation, so the debug info printed by the functions
        // is unconditionally displayed
        const useCredProvider = ngToolRunner.isCredentialProviderEnabled(quirks) && credProviderPath;
        const useCredConfig = ngToolRunner.isCredentialConfigEnabled(quirks) && !useCredProvider;

        // Setting up auth-related variables
        tl.debug("Setting up auth");
        let urlPrefixes = packagingLocation.PackagingUris;
        tl.debug(`Discovered URL prefixes: ${urlPrefixes}`);
        // Note to readers: This variable will be going away once we have a fix for the location service for
        // customers behind proxies
        const testPrefixes = tl.getVariable("NuGetTasks.ExtraUrlPrefixesForTesting");
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(";"));
            tl.debug(`All URL prefixes: ${urlPrefixes}`);
        }
        const accessToken = auth.getSystemAccessToken();
        const externalAuthArr: auth.ExternalAuthInfo[] = commandHelper.GetExternalAuthInfoArray("externalEndpoints");
        const authInfo = new auth.NuGetExtendedAuthInfo(new auth.InternalAuthInfo(urlPrefixes, accessToken, useCredProvider, useCredConfig), externalAuthArr);
        const environmentSettings: ngToolRunner.NuGetEnvironmentSettings = {
            credProviderFolder: useCredProvider ? path.dirname(credProviderPath) : null,
            extensionsDisabled: true,
        };

        // Setting up sources, either from provided config file or from feed selection
        tl.debug("Setting up sources");
        let nuGetConfigPath : string = undefined;
        let selectOrConfig = tl.getInput("selectOrConfig");
        // This IF is here in order to provide a value to nuGetConfigPath (if option selected, if user provided it)
        // and then pass it into the config helper
        if (selectOrConfig === "config") {
            nuGetConfigPath = tl.getPathInput("nugetConfigPath", false, true);
            if (!tl.filePathSupplied("nugetConfigPath")) {
                nuGetConfigPath = undefined;
            }
        }

        // If there was no nuGetConfigPath, NuGetConfigHelper will create a temp one
        const nuGetConfigHelper = new NuGetConfigHelper2(
                    nuGetPath,
                    nuGetConfigPath,
                    authInfo,
                    environmentSettings,
                    null);

        let credCleanup = () => { return; };

        // Now that the NuGetConfigHelper was initialized with all the known information we can proceed
        // and check if the user picked the 'select' option to fill out the config file if needed
        if (selectOrConfig === "select") {
            const sources: IPackageSource[] = new Array<IPackageSource>();
            const feed = tl.getInput("feedRestore");
            if (feed) {
                const feedUrl: string = await nutil.getNuGetFeedRegistryUrl(
                    packagingLocation.DefaultPackagingUri,
                    accessToken,
                    feed,
                    nuGetVersion);
                sources.push({
                    feedName: feed,
                    feedUri: feedUrl,
                    isInternal: true,
                });
            }

            const includeNuGetOrg = tl.getBoolInput("includeNuGetOrg", false);
            if (includeNuGetOrg) {
                const nuGetUrl: string = nuGetVersion.productVersion.a < 3
                                        ? locationHelpers.NUGET_ORG_V2_URL
                                        : locationHelpers.NUGET_ORG_V3_URL;
                sources.push({
                    feedName: "NuGetOrg",
                    feedUri: nuGetUrl,
                    isInternal: false,
                });
            }

            // Creating NuGet.config for the user
            if (sources.length > 0)
            {
                // tslint:disable-next-line:max-line-length
                tl.debug(`Adding the following sources to the config file: ${sources.map((x) => x.feedName).join(";")}`);
                nuGetConfigHelper.addSourcesToTempNuGetConfig(sources);
                credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath);
                nuGetConfigPath = nuGetConfigHelper.tempNugetConfigPath;
            }
            else {
                tl.debug("No sources were added to the temp NuGet.config file");
            }
        }

        // Setting creds in the temp NuGet.config if needed
        await nuGetConfigHelper.setAuthForSourcesInTempNuGetConfigAsync();

        // Use config file if:
        //     - User selected "Select feeds" option
        //     - User selected "NuGet.config" option and the nuGetConfig input has a value
        let useConfigFile: boolean = selectOrConfig === "select" || (selectOrConfig === "config" && !!nuGetConfigPath);
        let configFile = useConfigFile ? nuGetConfigHelper.tempNugetConfigPath : undefined;

        if (useConfigFile)
        {
            credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath);
        }

        try {
            const restoreOptions = new RestoreOptions(
                nuGetPath,
                configFile,
                noCache,
                disableParallelProcessing,
                verbosity,
                packagesDirectory,
                environmentSettings,
                authInfo);

            for (const solutionFile of filesList) {
                restorePackages(solutionFile, restoreOptions);
            }
        } finally {
            credCleanup();
        }

        tl.setResult(tl.TaskResult.Succeeded, tl.loc("PackagesInstalledSuccessfully"));
    } catch (err) {
        tl.error(err);

        if (buildIdentityDisplayName || buildIdentityAccount) {
            tl.warning(tl.loc("BuildIdentityPermissionsHint", buildIdentityDisplayName, buildIdentityAccount));
        }

        tl.setResult(tl.TaskResult.Failed, tl.loc("PackagesFailedToInstall"));
    }
}

function restorePackages(solutionFile: string, options: RestoreOptions): IExecSyncResult {
    const nugetTool = ngToolRunner.createNuGetToolRunner(options.nuGetPath, options.environment, options.authInfo);

    nugetTool.arg("restore");
    nugetTool.arg(solutionFile);

    if (options.packagesDirectory) {
        nugetTool.arg("-PackagesDirectory");
        nugetTool.arg(options.packagesDirectory);
    }

    if (options.noCache) {
        nugetTool.arg("-NoCache");
    }

    if (options.disableParallelProcessing) {
        nugetTool.arg("-DisableParallelProcessing");
    }

    if (options.verbosity && options.verbosity !== "-") {
        nugetTool.arg("-Verbosity");
        nugetTool.arg(options.verbosity);
    }

    nugetTool.arg("-NonInteractive");

    if (options.configFile) {
        nugetTool.arg("-ConfigFile");
        nugetTool.arg(options.configFile);
    }

    const execResult = nugetTool.execSync({ cwd: path.dirname(solutionFile) } as IExecOptions);
    if (execResult.code !== 0) {
        telemetry.logResult("Packaging", "NuGetCommand", execResult.code);
        throw tl.loc("Error_NugetFailedWithCodeAndErr",
            execResult.code,
            execResult.stderr ? execResult.stderr.trim() : execResult.stderr);
    }
    return execResult;
}
