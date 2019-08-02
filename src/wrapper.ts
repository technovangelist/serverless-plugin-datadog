import * as fs from "fs";
import * as path from "path";
import * as util from "util";

import { HandlerInfo, RuntimeType } from "./layer";

import Service from "serverless/classes/Service";
import { nodeTemplate } from "./templates/node-js-template";
import { pythonTemplate } from "./templates/python-template";
import { removeDirectory } from "./util";

const datadogDirectory = "datadog_handlers";

export async function writeHandlers(service: Service, handlers: HandlerInfo[]) {
  await removeDirectory(datadogDirectory);
  await util.promisify(fs.mkdir)(datadogDirectory);

  const promises = handlers.map(async (handlerInfo) => {
    const result = getWrapperText(handlerInfo);
    if (result === undefined) {
      return;
    }
    const { text, method } = result;
    const filename = await writeWrapperFunction(handlerInfo, text);
    handlerInfo.handler.handler = `${path.join(datadogDirectory, handlerInfo.name)}.${method}`;
    return `${filename}/**`;
  });
  const files = [...(await Promise.all(promises))];
  const allFiles = files.filter((file) => file !== undefined) as string[];
  allFiles.push(datadogDirectory);
  addToExclusionList(service, allFiles);
}

export async function cleanupHandlers() {
  await removeDirectory(datadogDirectory);
}

export function getWrapperText(handlerInfo: HandlerInfo) {
  const result = getHandlerPath(handlerInfo);
  if (result === undefined) {
    return;
  }
  const { method, filename } = result;

  switch (handlerInfo.type) {
    case RuntimeType.NODE:
      return { text: nodeTemplate(filename, method), method };
    case RuntimeType.PYTHON:
      return { text: pythonTemplate(filename, method), method };
  }
}

export async function writeWrapperFunction(handlerInfo: HandlerInfo, wrapperText: string) {
  const extension = handlerInfo.type === RuntimeType.PYTHON ? "py" : "js";
  const filename = `${handlerInfo.name}.${extension}`;
  const pathname = path.join(datadogDirectory, filename);
  await util.promisify(fs.writeFile)(pathname, wrapperText);
  return filename;
}

export function getHandlerPath(handlerInfo: HandlerInfo) {
  const handlerfile = handlerInfo.handler.handler;
  const parts = handlerfile.split(".");
  if (parts.length < 2) {
    return;
  }
  const method = parts[parts.length - 1];
  const filename = parts.slice(0, -1).join(".");
  return { method, filename };
}

export async function addToExclusionList(service: any, files: string[]) {
  if (service.package === undefined) {
    service.package = {};
  }
  const pack = service.package;
  if (pack.include === undefined) {
    pack.include = [];
  }
  pack.include.push(...files);
}