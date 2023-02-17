import Web3 from 'web3'
import { BN } from 'web3-utils'
import { Contract } from 'web3-eth-contract'

const web3 = new Web3(web3Provider)

const libraries = {}

const MISC_ACC = 0
const NFTFI_ACC = 1
const BORROWER1_ACC = 2
const BORROWER2_ACC = 3
const STRUCTURER_ACC = 4
const INVESTOR1_ACC = 5
const INVESTOR2_ACC = 6
const INVESTOR3_ACC = 7
const INVESTOR4_ACC = 8

const APE_PRICE = 80_000_000_000_000_000;
const ADMIN_FEE = 500
const CHAINID = 1;

// #region Helper methods

const getAccount = async (accountIndex: number): Promise<string> => {
    const accounts = await web3.eth.getAccounts()
    return accounts[accountIndex]
}

const deployLibrary = async (
    libraryPath: string,
    libraryName: string,
    account: string,
): Promise<void> => {
    const artifactsPath = `browser/${libraryPath}/artifacts/${libraryName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: metadata.data.bytecode.object})
        .send({from: account, gas: 10**9})
    const libraryFile = `${libraryPath}/${libraryName}.sol`
    libraries[libraryFile] = {}
    libraries[libraryFile][libraryName] = contract.options.address
}

const deploy = async (
    contractName: string,
    args: Array<any>,
    account: string,
): Promise<Contract> => {   
    const artifactsPath = `browser/contracts/artifacts/${contractName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    let bytecode = metadata.data.bytecode.object
    const linkReferences = metadata.data.bytecode.linkReferences
    for (let libraryFile in linkReferences) {
        const fileReferences = linkReferences[libraryFile]
        for (let libraryName in fileReferences) {
            const occurrences = fileReferences[libraryName]
            for (let i = 0; i < occurrences.length; i++) {
                bytecode = (
                    bytecode.substring(0, 2 * occurrences[i].start)
                    + libraries[libraryFile][libraryName].substring(2)
                    + bytecode.substring(2 * occurrences[i].start + 40)
                )
            }
        }
    }
    return (new web3.eth.Contract(metadata.abi))
        .deploy({data: bytecode, arguments: args})
        .send({from: account, gas: 10**9})
}

// #region Initializing contracts

const initBayc = async (miscAcc: string, borrower1Acc: string, borrower2Acc: string): Promise<Contract> => {
    const bayc = await deploy('BoredApeYachtClub', ['BoredApeYachtClub', 'BAYC', 10000, 0], miscAcc)
    await bayc.methods.flipSaleState().send({from: miscAcc})
    await Promise.all([
        bayc.methods.mintApe(1).send({from: borrower1Acc, value: APE_PRICE}),
        bayc.methods.mintApe(1).send({from: borrower2Acc, value: APE_PRICE}),
    ])
    return bayc
}

const initWeth = async (miscAcc: string): Promise<Contract> => {
    return deploy('WETH9', [], miscAcc)
}

const initNftfiLibs = async (nftfiAcc: string): Promise<void> => {
    await Promise.all([
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanAirdropUtils', nftfiAcc),
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanChecksAndCalculations', nftfiAcc),
        deployLibrary('contracts/utils', 'ContractKeys', nftfiAcc),
        deployLibrary('contracts/utils', 'NFTfiSigningUtils', nftfiAcc),
    ])
}

const initNftfiHub = async (nftfiAcc: string): Promise<[string, Contract, Contract]> => {
    const nftfiErc721Wrapper = await deploy('ERC721Wrapper', [], nftfiAcc)
    return [nftfiAcc, nftfiErc721Wrapper, await deploy('NftfiHub', [nftfiAcc, [], []], nftfiAcc)]
}

const initNftfiPermNfts = async (
    nftfiOwner: string,
    nftfiErc721Wrapper: Contract,
    nftfiHub: Contract,
    bayc: Contract,
    nftfiAcc: string,
): Promise<void> => {
    const nftfiPermNfts = await deploy(
        'PermittedNFTsAndTypeRegistry',
        [
            nftfiOwner,
            nftfiHub.options.address,
            ['BoredApeYachtClub'],
            [nftfiErc721Wrapper.options.address],
            [bayc.options.address],
            ['BoredApeYachtClub'],
        ],
        nftfiAcc,
    )
    await nftfiHub.methods.setContract('PERMITTED_NFTS', nftfiPermNfts.options.address).send({from: nftfiAcc})
}

const initNiftfi = async (
    nftfiOwner: string,
    nftfiHub: Contract,
    weth: Contract,
    nftfiAcc: string,
): Promise<Contract> => {
    const nftfi = await deploy('DirectLoanFixedOfferRedeploy', [nftfiOwner, nftfiHub.options.address, [weth.options.address]], nftfiAcc)
    await nftfi.methods.updateAdminFee(ADMIN_FEE).send({from: nftfiAcc})
    return nftfi
}

const initNftSec = async (weth: Contract, nftfi: Contract, nftfiErc721Wrapper: Contract, miscAcc: string): Promise<Contract> => {
    return deploy('NftSec', [weth.options.address, nftfi.options.address, nftfiErc721Wrapper.options.address], miscAcc)
}

const init = async (
    miscAcc: string,
    nftfiAcc: string,
    borrower1Acc: string,
    borrower2Acc: string
): Promise<[Contract, Contract, Contract, Contract]> => {
    await initNftfiLibs(nftfiAcc)
    const [bayc, weth, [nftfiOwner, nftfiErc721Wrapper, nftfiHub]] = await Promise.all([
        initBayc(miscAcc, borrower1Acc, borrower2Acc),
        initWeth(miscAcc),
        initNftfiHub(nftfiAcc),
    ])
    const [, nftfi] = await Promise.all([
        initNftfiPermNfts(nftfiOwner, nftfiErc721Wrapper, nftfiHub, bayc, nftfiAcc),
        initNiftfi(nftfiOwner, nftfiHub, weth, nftfiAcc),
    ])
    console.log(`DirectLoanFixedOfferRedeploy address: ${nftfi.options.address}`)
    const nftSec = await initNftSec(weth, nftfi, nftfiErc721Wrapper, miscAcc)
    return [bayc, weth, nftfi, nftSec]
}

// #region Sourcing and structuring tranches

const acceptOffer = async (
    loanPrincipalAmount: web3.utils.BN,
    maximumRepaymentAmount: number,
    nftCollateralId: number,
    nftCollateralContract: string,
    loanERC20Denomination: string,
    nonce: number,
    structurerAcc: string,
    nftfi: Contract,
    borrower: string,
): Promise<void> => {
    const loanDuration = 10000
    const referrer = '0x0000000000000000000000000000000000000000'
    const expiry = 2 * 10**9
    const data = web3.utils.soliditySha3(
        {t: 'address', v: loanERC20Denomination},
        {t: 'uint256', v: loanPrincipalAmount},
        {t: 'uint256', v: maximumRepaymentAmount},
        {t: 'address', v: nftCollateralContract},
        {t: 'uint256', v: nftCollateralId},
        {t: 'address', v: referrer},
        {t: 'uint32', v: loanDuration},
        {t: 'uint16', v: ADMIN_FEE},
        {t: 'address', v: structurerAcc},
        {t: 'uint256', v: nonce},
        {t: 'uint256', v: expiry},
        {t: 'address', v: nftfi.options.address},
        {t: 'uint256', v: CHAINID},
    )
    const signature = web3.eth.sign(data, structurerAcc)
    await nftfi.methods.acceptOffer(
        [
            loanPrincipalAmount,
            maximumRepaymentAmount,
            nftCollateralId,
            nftCollateralContract,
            loanDuration,
            ADMIN_FEE,
            loanERC20Denomination,
            referrer,
        ],
        [
            nonce,
            expiry,
            structurerAcc,
            signature,
        ],
        [
            referrer,
            0,
        ]
    ).send({from: borrower})
}

const structure = async (
    bayc: Contract,
    weth: Contract,
    nftfi: Contract,
    structurerAcc: string,
    borrower1Acc: string,
    borrower2Acc: string,
): Promise<void> => {
    await Promise.all([
        acceptOffer(
            web3.utils.toBN('1_000_000_000_000_000_000'),
            web3.utils.toBN('1_100_000_000_000_000_000'),
            0,
            bayc.options.address,
            weth.options.address,
            0,
            structurerAcc,
            nftfi,
            borrower1Acc,
        ),
        // acceptOffer(
        //     5 * 10**18,
        //     7 * 10**18,
        //     1,
        //     bayc.options.address,
        //     weth.options.address,
        //     1,
        //     structurerAcc,
        //     nftfi,
        //     borrower2Acc,
        // ),
    ])
}

(async () => {
    try {
        const [
            miscAcc,
            nftfiAcc,
            borrower1Acc,
            borrower2Acc,
            structurerAcc,
            investor1Acc,
            investor2Acc,
            investor3Acc,
            investor4Acc,
        ] = await Promise.all([
            MISC_ACC,
            NFTFI_ACC,
            BORROWER1_ACC,
            BORROWER2_ACC,
            STRUCTURER_ACC,
            INVESTOR1_ACC,
            INVESTOR2_ACC,
            INVESTOR3_ACC,
            INVESTOR4_ACC,
        ].map(getAccount))

        const [bayc, weth, nftfi, nftSec] = await init(miscAcc, nftfiAcc, borrower1Acc, borrower2Acc)
        await structure(bayc, weth, nftfi, structurerAcc, borrower1Acc, borrower2Acc)
    } catch (e) {
        console.log(e.stack)
    }
})()