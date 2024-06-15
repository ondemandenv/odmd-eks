import {CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse, Context} from "aws-lambda";
import {
    BranchDoesNotExistException,
    CodeCommitClient,
    CommitDoesNotExistException,
    GetFileCommand, PutFileCommand, SameFileContentException
} from "@aws-sdk/client-codecommit";

export async function handler(event: CloudFormationCustomResourceEvent, context: Context): Promise<CloudFormationCustomResourceResponse> {

    if (event.RequestType == "Delete") {

        return {
            PhysicalResourceId: event.LogicalResourceId,
            StackId: event.StackId,
            RequestId: event.RequestId,
            Status: "SUCCESS",
            LogicalResourceId: event.LogicalResourceId
        }
    }

    const repositoryName = event.ResourceProperties.repositoryName as string
    const filePath = event.ResourceProperties.filePath as string
    const branch = event.ResourceProperties.branch as string
    const fileContent = Buffer.from(event.ResourceProperties.fileContent as string)


    const codecommit = new CodeCommitClient({})

    let parentCommitId = undefined
    try {
        let so = await codecommit.send(new GetFileCommand({
            repositoryName,
            commitSpecifier: branch,
            filePath
        }));

        parentCommitId = so.commitId
    } catch (e) {
        if (e instanceof BranchDoesNotExistException || e instanceof CommitDoesNotExistException) {
            //empt
        } else {
            throw e
        }
    }

    try {
        await codecommit.send(new PutFileCommand({
            parentCommitId,
            branchName: branch,
            repositoryName,
            filePath,
            fileContent
        }))
    } catch (e) {
        /**
         * SameFileContentException: The content of the file is exactly the same as the content of the file in the AWS CodeCommit repository and branch you specified. The file has not been added.
         */
        if (e instanceof SameFileContentException) {
            console.log('SameFileContentException!')
        } else {
            throw e
        }
    }

    return {
        PhysicalResourceId: event.StackId + event.LogicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        Status: "SUCCESS",
        LogicalResourceId: event.LogicalResourceId
    }
}
