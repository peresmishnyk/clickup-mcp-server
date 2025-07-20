/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * ClickUp MCP Version Tool
 * 
 * This module provides version information about the ClickUp MCP server.
 * Useful for diagnostics and ensuring the correct version is being used.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';
import { sponsorService } from '../utils/sponsor-service.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const logger = new Logger('VersionTool');

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Tool definition for getting version information
 */
export const getVersionTool: Tool = {
  name: 'get_version',
  description: `Returns version information about the ClickUp MCP server including package version, build timestamp, and git information for diagnostics.`,
  inputSchema: {
    type: 'object',
    properties: {
      random_string: {
        type: 'string',
        description: 'Dummy parameter for no-parameter tools'
      }
    },
    required: ['random_string']
  }
};

/**
 * Handler for the get_version tool
 */
export async function handleGetVersion() {
  try {
    logger.debug('Getting version information');

    const versionInfo = await getVersionInfo();
    
    return sponsorService.createResponse(versionInfo, true);
  } catch (error: any) {
    logger.error('Error getting version information', { error: error.message });
    return sponsorService.createErrorResponse(`Error getting version information: ${error.message}`);
  }
}

/**
 * Get comprehensive version information
 */
async function getVersionInfo() {
  const info: any = {
    timestamp: new Date().toISOString(),
    server: 'ClickUp MCP Server'
  };

  try {
    // Get package.json version
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      info.package = {
        name: packageData.name,
        version: packageData.version,
        description: packageData.description
      };
    }

    // Get build information
    try {
      const buildInfoPath = path.resolve(__dirname, '../build-info.json');
      if (fs.existsSync(buildInfoPath)) {
        const buildData = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
        info.build = buildData;
      }
    } catch (buildError) {
      // Build info is optional
      logger.debug('No build info available', { error: buildError });
    }

    // Try to get git information
    try {
      const { execSync } = await import('child_process');
      
      // Get current commit hash
      try {
        const gitHash = execSync('git rev-parse HEAD', { 
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        info.git = { 
          commit: gitHash.substring(0, 8),
          fullCommit: gitHash
        };
      } catch {
        // Git info is optional
      }

      // Get current branch
      try {
        const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { 
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        if (info.git) {
          info.git.branch = gitBranch;
        }
      } catch {
        // Branch info is optional
      }

      // Get last commit date
      try {
        const lastCommitDate = execSync('git log -1 --format=%ci', { 
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        if (info.git) {
          info.git.lastCommitDate = lastCommitDate;
        }
      } catch {
        // Commit date is optional
      }

    } catch (gitError) {
      logger.debug('Git information not available', { error: gitError });
    }

    // Runtime information
    info.runtime = {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptime: process.uptime()
    };

    // Enhanced version for add_task_to_list testing
    info.features = {
      addTaskToList: {
        version: '2.0',
        supportedFeatures: [
          'explicit response support',
          'detailed logging',
          'post-operation verification',
          'multi-list validation',
          'enhanced error handling'
        ],
        lastUpdated: '2025-01-20'
      }
    };

    logger.debug('Version information gathered successfully', { info });
    return info;

  } catch (error: any) {
    logger.error('Error gathering version information', { error: error.message });
    throw new Error(`Failed to gather version information: ${error.message}`);
  }
} 