import { debug } from "console";
import Service from "serverless/classes/Service";
import Aws = require("serverless/plugins/aws/provider/awsProvider");

const logGroupKey = "AWS::Logs::LogGroup";
const logGroupSubscriptionKey = "AWS::Logs::SubscriptionFilter";
const maxAllowableLogGroupSubscriptions: number = 2;

class DatadogForwarderNotFoundError extends Error {
  constructor(message: string) {
    super(...message);
    this.name = "DatadogForwarderNotFoundError";
    this.message = message;
  }
}

interface LogGroupResource {
  Type: typeof logGroupKey;
  Properties: {
    LogGroupName: string;
  };
}

interface DescribeSubscriptionFiltersResponse {
  subscriptionFilters: {
    creationTime: number;
    destinationArn: string;
    distribution: string;
    filterName: string;
    filterPattern: string;
    logGroupName: string;
    roleArn: string;
  }[];
}

// When users define ARN with CloudFormation functions, the ARN takes this type instead of a string.
export interface CloudFormationObjectArn {
  "Fn::Sub"?: string;
  "arn:aws"?: string;
}

function isLogGroup(value: any): value is LogGroupResource {
  return value.Type === logGroupKey;
}

/**
 * Validates whether Lambda forwarder exists in the account
 * @param aws Serverless framework provided AWS client
 * @param functionArn The forwarder ARN to be validated
 */
async function validateForwarderArn(aws: Aws, functionArn: CloudFormationObjectArn | string) {
  try {
    await aws.request("Lambda", "getFunction", { FunctionName: functionArn });
  } catch (err) {
    throw new DatadogForwarderNotFoundError(`Could not perform GetFunction on ${functionArn}.`);
  }
}

export async function addCloudWatchForwarderSubscriptions(
  service: Service,
  aws: Aws,
  functionArn: CloudFormationObjectArn | string,
) {
  const resources = service.provider.compiledCloudFormationTemplate?.Resources;
  if (resources === undefined) {
    return ["No cloudformation stack available. Skipping subscribing Datadog forwarder."];
  }
  const errors = [];
  if (typeof functionArn !== "string") {
    errors.push("Skipping forwarder ARN validation because forwarder string defined with CloudFormation function.");
  } else {
    await validateForwarderArn(aws, functionArn);
  }
  for (const [name, resource] of Object.entries(resources)) {
    if (!isLogGroup(resource) || !resource.Properties.LogGroupName.startsWith("/aws/lambda/")) {
      continue;
    }
    const logGroupName = resource.Properties.LogGroupName;
    const scopedSubName = `${name}Subscription`;

    let expectedSubName = `${service.getServiceName()}-${aws.getStage()}-${scopedSubName}-`;

    const stackName = aws.naming.getStackName();
    if (stackName) {
      expectedSubName = `${stackName}-${scopedSubName}-`;
    }

    const canSub = await canSubscribeLogGroup(aws, logGroupName, expectedSubName);
    if (!canSub) {
      errors.push(
        `Could not subscribe Datadog Forwarder due to too many existing subscription filter(s) for ${logGroupName}.`,
      );
      continue;
    }

    const subscription = {
      Type: logGroupSubscriptionKey,
      Properties: {
        DestinationArn: functionArn,
        FilterPattern: "",
        LogGroupName: { Ref: name },
      },
    };
    resources[scopedSubName] = subscription;
  }
  return errors;
}

export async function canSubscribeLogGroup(aws: Aws, logGroupName: string, expectedSubName: string) {
  const subscriptionFilters = await describeSubscriptionFilters(aws, logGroupName);
  const numberOfActiveSubscriptionFilters: number = subscriptionFilters.length;
  let foundDatadogSubscriptionFilter: boolean = false;
  for (const subscription of subscriptionFilters) {
    const filterName = subscription.filterName;
    if (filterName.startsWith(expectedSubName)) {
      foundDatadogSubscriptionFilter = true;
    }
  }
  if (!foundDatadogSubscriptionFilter && numberOfActiveSubscriptionFilters >= maxAllowableLogGroupSubscriptions) {
    return false;
  } else {
    return true;
  }
}

export async function describeSubscriptionFilters(aws: Aws, logGroupName: string) {
  try {
    const result: DescribeSubscriptionFiltersResponse = await aws.request(
      "CloudWatchLogs",
      "describeSubscriptionFilters",
      {
        logGroupName,
      },
    );
    return result.subscriptionFilters;
  } catch (err) {
    // An error will occur if the log group doesn't exist, so we swallow this and return an empty list.
    return [];
  }
}
