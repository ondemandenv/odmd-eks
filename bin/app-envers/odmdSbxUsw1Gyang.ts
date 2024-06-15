import {AppEnverConfig} from "../../lib/app-enver-config";

export class EnverConfigImpl implements AppEnverConfig {
    argocdNamespace: string = 'argocd';
    argocdRelease: string = 'gyang';
    argocdRepoSA: string = "argocd-repo-server";
}
