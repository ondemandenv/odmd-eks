import {AppEnverConfig} from "../lib/app-enver-config";
import {
    OndemandContracts
} from "@ondemandenv/odmd-contracts";
import {EksClusterEnverArgo} from "@ondemandenv/odmd-contracts/lib/repos/__eks/odmd-build-eks-cluster";

export class CurrentEnver {

    private constructor(enverConfigImpl: AppEnverConfig) {
        this.localConfig = enverConfigImpl

        this.eksCluster = OndemandContracts.inst.eksCluster.argoClusterEnver


        /**
         * for dynamic contract enver:
         */
        // this.eksCluster = OndemandContracts.inst.eksClusterConfig.envers.find(e => e.targetRevision == process.env.SRC_BRANCH)!
        // this.eksKubeSg = OndemandContracts.inst.eksClusterKubeSgsConfig.envers.find(e => e.targetRevision == process.env.SRC_BRANCH)!
    }

    private static _inst: CurrentEnver;
    public static get inst() {
        return this._inst
    }

    static async init() {
        if (CurrentEnver.inst) {
            throw new Error("can't init twice")
        }

        let revref = OndemandContracts.REV_REF_value;
        if (revref.includes('@')) {
            revref = revref.split('@')[0]
        }
        revref = revref.substring(3)
        const {EnverConfigImpl} = await import( (`./app-envers/${revref}`) )

        this._inst = new CurrentEnver(new EnverConfigImpl() as AppEnverConfig)
    }

    public readonly eksCluster: EksClusterEnverArgo;
    public readonly localConfig: AppEnverConfig;

}