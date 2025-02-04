import * as FS from 'fs';
import * as Path from 'path';
import { TWConfig } from 'bm-thing-transformer';
import { TSUtilities } from '../Utilities/TSUtilities';
import { TWClient } from '../Utilities/TWClient';
import AdmZip from 'adm-zip';

const [, , , ...args] = process.argv;

/**
 * Uploads the archive from the build folder to thingworx.
 */
export async function upload(): Promise<void> {
    const cwd = process.cwd();

    // Load the twconfig file which contains compilation options.
    const twConfig = require(`${process.cwd()}/twconfig.json`) as TWConfig;

    // When running separate in multi project mode, the zip files have to be imported
    // in the appropriate order
    const isMerged = args.includes('--merged');
    const isSeparate = args.includes('--separate') || !isMerged;

    // Load the twconfig file which contains the version and package name information.
    const packageJSON = require(`${process.cwd()}/package.json`);

    // If extensions are specified, create a zip with them and upload them
    if (args.includes('--extensions')) {
        // Create a zip file with all of the extensions so thingworx can determine
        // the correct order in which they should install
        const admArchive = new AdmZip();
        admArchive.addLocalFolder(Path.join(cwd, 'extensions'));

        await new Promise<void>((resolve, reject) => {
            admArchive.writeZip(Path.join(cwd, 'zip', 'extensions.zip'), (error) => {
                if (error) return reject(error);

                resolve();
            });
        });

        // Deploy the extensions
        try {
            await uploadZip(Path.join(cwd, 'zip', 'extensions.zip'), 'Extensions');
        }
        catch (e) {
            // The extensions failing is non-critical, so a project upload is attempted
            // even if an error occurs at this step
        }

        // Delete the combined extensions zip after installation
        FS.rmSync(Path.join(cwd, 'zip', 'extensions.zip'));
    }

    if (isSeparate && twConfig.projectName == '@auto') {
        // In separate mode, it is necessary to upload the projects in dependency order
        for (const project of TSUtilities.dependencySortedProjects().reverse()) {
            const zipName = `${packageJSON.name}-${project.name}-${packageJSON.version}.zip`;

            await uploadZip(`${cwd}/zip/projects/${zipName}`, project.name);
        };
    }
    else {
        // In merged mode, just upload the resulting zip
        const zipName = `${packageJSON.name}-${packageJSON.version}.zip`;

        await uploadZip(`${cwd}/zip/${zipName}`);
    }
}

/**
 * Uploads the zip at the given path to the thingworx server.
 * @param path      The path to the zip file to upload.
 * @param name      If specified, the name of the project that should appear in the console.
 */
async function uploadZip(path: string, name?: string): Promise<void> {
    process.stdout.write(`\x1b[2m❯\x1b[0m Uploading${name ? ` ${name}` : ''} to ${TWClient.server}`);

    const formData = {
        file: FS.createReadStream(path)
    };

    const response = await TWClient.importExtension(formData);

    if (response.statusCode != 200) {
        process.stdout.write(`\r\x1b[1;31m✖\x1b[0m Unable to upload${name ? ` ${name}` : ''} to ${TWClient.server}\n`);
        throw new Error(`\x1b[1;31mFailed to upload project to thingworx with status code ${response.statusCode} (${response.statusMessage})\x1b[0m
${formattedUploadStatus(response.body)}`);
    }

    process.stdout.write(`\r\x1b[1;32m✔\x1b[0m Uploaded${name ? ` ${name}` : ''} to ${TWClient.server}    \n`);
    process.stdout.write(formattedUploadStatus(response.body));
}


/**
 * Returns a formatted string that contains the validation and installation status extracted
 * from the given server response.
 * @param {string} response         The server response.
 * @returns {string}                The formatted upload status.
 */
 function formattedUploadStatus(response) {
    let infotable;
    let result = '';
    try {
        infotable = JSON.parse(response);

        // The upload response is an infotable with rows with two possible properties:
        // validate - an infotable where each row contains the validation result for each attempted extension
        // install - if validation passed, an infotable where each row contains the installation result for each attempted extension
        const validations = infotable.rows.filter(r => r.validate);
        const installations = infotable.rows.filter(r => r.install);

        const validation = validations.length && {rows: Array.prototype.concat.apply([], validations.map(v => v.validate.rows))};
        const installation = installations.length && {rows: Array.prototype.concat.apply([], installations.map(i => i.install.rows))};

        // A value of 1 for extensionReportStatus indicates failure, 2 indicates warning, and 0 indicates success
        for (const row of validation.rows) {
            if (row.extensionReportStatus == 1) {
                result += `🛑 \x1b[1;31mValidation failed\x1b[0m for "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
            else if (row.extensionReportStatus == 2) {
                result += `🔶 \x1b[1;33mValidation warning\x1b[0m for "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
            else {
                result += `✅ \x1b[1;32mValidation passed\x1b[0m for "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
        }

        if (!installation) return result;

        // If an installation status is provided, display it as well; it has the same format as validation
        for (const row of installation.rows) {
            if (row.extensionReportStatus == 1) {
                result += `🛑 \x1b[1;31mInstallation failed\x1b[0m for "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
            else if (row.extensionReportStatus == 2) {
                result += `🔶 \x1b[1;33mInstallation warning\x1b[0m for "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
            else {
                result += `✅ \x1b[1;32mInstalled\x1b[0m "${row.extensionPackage.rows[0].name}-${row.extensionPackage.rows[0].packageVersion}": "${row.reportMessage}"\n`;
            }
        }

        return result;
    }
    catch (e) {
        // If the response isn't a parsable response, it is most likely a simple message
        // that may be printed directly.
        return response;
    }
}