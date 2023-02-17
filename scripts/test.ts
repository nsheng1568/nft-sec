import Web3 from 'web3'
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

const APE_PRICE = '80000000000000000'; // 0.08 ETH, the initial BAYC release price
const ADMIN_FEE = 500 // 500 bps, the current NFTfi admin fee
const CHAINID = 1;

interface Contracts {
    bayc: Contract,
    weth: Contract,
    nftfi: Contract,
    nftfiLoanCoord: Contract,
    nftfiPromNote: Contract,
    nftSec: Contract,
}

// #region Helper methods

/* Get Remix-provided account address for the given index */
const getAccount = async (accountIndex: number): Promise<string> => {
    const accounts = await web3.eth.getAccounts()
    return accounts[accountIndex]
}

/* Deploy library contract and save its metadata globally for linking into top-level contracts */
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
    console.log(`Deployed ${libraryName} at address ${contract.options.address}`)
}

/* Deploy contract with the given arguments and return it */
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
                // Link previously deployed libraries by replacing placeholders in the compiled bytecode
                bytecode = (
                    bytecode.substring(0, 2 * occurrences[i].start)
                    + libraries[libraryFile][libraryName].substring(2)
                    + bytecode.substring(2 * occurrences[i].start + 40)
                )
            }
        }
    }
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: bytecode, arguments: args})
        .send({from: account, gas: 10**9})
    console.log(`Deployed ${contractName} at address ${contract.options.address}`)
    return contract
}

// #region Initializing contracts

/* Deploy BoredApeYachtClub contract and have the two borrowers each buy one */
const initBayc = async (miscAcc: string, borrower1Acc: string, borrower2Acc: string): Promise<Contract> => {
    const bayc = await deploy('BoredApeYachtClub', ['BoredApeYachtClub', 'BAYC', 10000, 0], miscAcc)
    await bayc.methods.flipSaleState().send({from: miscAcc}) // Begin sale of apes

    // Borrowers buy apes
    await bayc.methods.mintApe(1).send({from: borrower1Acc, value: APE_PRICE})
    await bayc.methods.mintApe(1).send({from: borrower2Acc, value: APE_PRICE})

    // Verify the apes are bought
    const [bayc0Acc, bayc1Acc] = await Promise.all([
        bayc.methods.ownerOf(0).call(),
        bayc.methods.ownerOf(1).call(),
    ])
    if (bayc0Acc === borrower1Acc) {
        console.log(`Bored Ape 0 purchased by Borrower 1`)
    }
    if (bayc1Acc === borrower2Acc) {
        console.log(`Bored Ape 1 purchased by Borrower 2`)
    }

    return bayc
}

/* Deploy wETH contract */
const initWeth = async (miscAcc: string): Promise<Contract> => {
    return deploy('WETH9', [], miscAcc)
}

/* Deploy NFTfi libraries */
const initNftfiLibs = async (nftfiAcc: string): Promise<void> => {
    await Promise.all([
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanAirdropUtils', nftfiAcc),
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanChecksAndCalculations', nftfiAcc),
        deployLibrary('contracts/utils', 'ContractKeys', nftfiAcc),
        deployLibrary('contracts/utils', 'NFTfiSigningUtils', nftfiAcc),
    ])
}

/* Deploy NFTfi hub for keeping track of NFTfi-related contracts */
const initNftfiHub = async (nftfiAcc: string): Promise<Contract> => {
    return deploy('NftfiHub', [nftfiAcc, [], []], nftfiAcc)
}

/* Deploy NFTfi ERC721 wrapper contract for abstracting collateral transactions */
const initNftfiErc721Wrapper = async(nftfiAcc: string): Promise<Contract> => {
    return deploy('ERC721Wrapper', [], nftfiAcc)
}

/* Deploy NFTfi Permitted NFTs contract for registering collection permissions, and track it in the hub */
const initNftfiPermNfts = async (
    nftfiErc721Wrapper: Contract,
    nftfiHub: Contract,
    bayc: Contract,
    nftfiAcc: string,
): Promise<void> => {
    const nftfiPermNfts = await deploy(
        'PermittedNFTsAndTypeRegistry',
        [
            nftfiAcc,
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

/**
 * Deploy NFTfi Direct Loan Coordinator contract for registering loans, and track it in the hub.
 * Also, deploy SmartNft contracts representing the Promissory Note and Obligation Record, and initialize them
 * in the loan coordinator.
 */
const initNftfiLoanCoord = async (
    nftfiHub: Contract,
    nftfi: Contract,
    nftfiAcc: string,
): Promise<[Contract, Contract]> => {
    const nftfiLoanCoord = await deploy(
        'DirectLoanCoordinator',
        [
            nftfiHub.options.address,
            nftfiAcc,
            ['DIRECT_LOAN_FIXED_REDEPLOY'],
            [nftfi.options.address],
        ],
        nftfiAcc,
    )
    const [nftfiPromNote, nftfiObliNote] = await Promise.all([
        deploy(
            'SmartNft',
            [
                nftfiAcc,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Promissory Note',
                'PNNFI',
                'https://metadata.nftfi.com/loans/v2/promissory/1/',
            ],
            nftfiAcc,
        ),
        deploy(
            'SmartNft',
            [
                nftfiAcc,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Obligation Receipt',
                'ORNFI',
                'https://metadata.nftfi.com/loans/v2/obligation/1/',
            ],
            nftfiAcc,
        ),
    ])
    await Promise.all([
        nftfiLoanCoord.methods.initialize(nftfiPromNote.options.address, nftfiObliNote.options.address).send({from: nftfiAcc}),
        nftfiHub.methods.setContract('DIRECT_LOAN_COORDINATOR', nftfiLoanCoord.options.address).send({from: nftfiAcc}),
    ])
    return [nftfiLoanCoord, nftfiPromNote]
}

/* Deploy Direct Loan contract, which is the main entry point for NFTfi interactions, and set its admin fee */
const initNiftfi = async (
    nftfiHub: Contract,
    weth: Contract,
    nftfiAcc: string,
): Promise<Contract> => {
    const nftfi = await deploy('DirectLoanFixedOfferRedeploy', [nftfiAcc, nftfiHub.options.address, [weth.options.address]], nftfiAcc)
    await nftfi.methods.updateAdminFee(ADMIN_FEE).send({from: nftfiAcc})
    return nftfi
}

/* Deploy NftSec contract, containing our securitized product logic */
const initNftSec = async (weth: Contract, nftfi: Contract, nftfiErc721Wrapper: Contract, miscAcc: string): Promise<Contract> => {
    return deploy('NftSec', [weth.options.address, nftfi.options.address, nftfiErc721Wrapper.options.address], miscAcc)
}

/* Initialize all contracts and return a bundle of them for future use */
const init = async (
    miscAcc: string,
    nftfiAcc: string,
    borrower1Acc: string,
    borrower2Acc: string
): Promise<Contracts> => {
    console.log('\nInitializing contracts...')
    await initNftfiLibs(nftfiAcc)
    const [bayc, weth, nftfiHub, nftfiErc721Wrapper] = await Promise.all([
        initBayc(miscAcc, borrower1Acc, borrower2Acc),
        initWeth(miscAcc),
        initNftfiHub(nftfiAcc),
        initNftfiErc721Wrapper(nftfiAcc),
    ])
    const nftfi = await initNiftfi(nftfiHub, weth, nftfiAcc)
    const [[nftfiLoanCoord, nftfiPromNote],] = await Promise.all([
        initNftfiLoanCoord(nftfiHub, nftfi, nftfiAcc),
        initNftfiPermNfts(nftfiErc721Wrapper, nftfiHub, bayc, nftfiAcc),
    ])
    const nftSec = await initNftSec(weth, nftfi, nftfiErc721Wrapper, miscAcc)
    return {
        bayc: bayc,
        weth: weth,
        nftfi: nftfi,
        nftfiLoanCoord: nftfiLoanCoord,
        nftfiPromNote: nftfiPromNote,
        nftSec: nftSec,
    }
}

// #region Sourcing and structuring tranches

/* Sign and accept an offer to initiate a loan on NFTfi */
const acceptOffer = async (
    contracts: Contracts,
    loanPrincipalAmount: string,
    maximumRepaymentAmount: string,
    nftCollateralId: number,
    loanDuration: number,
    nonce: number,
    structurerAcc: string,
    borrowerAcc: string,
): Promise<void> => {
    const referrer = '0x0000000000000000000000000000000000000000' // no referrer
    const expiry = 2 * 10**9 // expiry far in the future
    const data = web3.utils.soliditySha3(
        {t: 'address', v: contracts.weth.options.address},
        {t: 'uint256', v: loanPrincipalAmount},
        {t: 'uint256', v: maximumRepaymentAmount},
        {t: 'address', v: contracts.bayc.options.address},
        {t: 'uint256', v: nftCollateralId},
        {t: 'address', v: referrer},
        {t: 'uint32', v: loanDuration},
        {t: 'uint16', v: ADMIN_FEE},
        {t: 'address', v: structurerAcc},
        {t: 'uint256', v: nonce},
        {t: 'uint256', v: expiry},
        {t: 'address', v: contracts.nftfi.options.address},
        {t: 'uint256', v: CHAINID},
    )
    const [signature,] = await Promise.all([
        web3.eth.sign(data, structurerAcc), // structurer signs the offer
        contracts.bayc.methods.approve(contracts.nftfi.options.address, nftCollateralId).send({from: borrowerAcc}), // borrower approves NFT transfer
    ])
    await contracts.nftfi.methods.acceptOffer(
        [
            loanPrincipalAmount,
            maximumRepaymentAmount,
            nftCollateralId,
            contracts.bayc.options.address,
            loanDuration,
            ADMIN_FEE,
            contracts.weth.options.address,
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
    ).send({from: borrowerAcc})
}

/* Obtain wETH for account by depositing ETH */
const obtainWeth = async (contracts: Contracts, amount: string, acc: string): Promise<void> => {
    await contracts.weth.methods.deposit().send({from: acc, value: amount})
}

/* Get current wETH balance for account */
const getWethBalance = async (contracts: Contracts, acc: string): Promise<number> => {
    return contracts.weth.methods.balanceOf(acc).call()
}

/* Approve transfer of wETH to NFTfi from account */
const approveWethToNftfi = async (contracts: Contracts, amount: string, acc: string): Promise<void> => {
    await contracts.weth.methods.approve(contracts.nftfi.options.address, amount).send({from: acc})
}

/* Get current owner of promissory note associated with loanId */
const getLoanOwner = async (contracts: Contracts, loanId: number): Promise<string> => {
    return contracts.nftfiLoanCoord.methods.getLoanData(loanId).call().then(loanData =>
        contracts.nftfiPromNote.methods.ownerOf(loanData[1]).call())
}

/* Initiate two NFTfi loans between structurer and borrowers */
const initiateLoans = async (
    contracts: Contracts,
    structurerAcc: string,
    borrower1Acc: string,
    borrower2Acc: string,
): Promise<void> => {
    console.log('\nInitiating NFTfi loans...')
    await Promise.all([
        obtainWeth(contracts, '10000000000000000000', structurerAcc), // Obtain 10 wETH
        approveWethToNftfi(contracts, '10000000000000000000', structurerAcc) // Approve transfer of 10 wETH
    ])

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, structurerAcc),
        getWethBalance(contracts, borrower1Acc),
        getWethBalance(contracts, borrower2Acc),
    ])
    .then(results => console.log(
        'wETH balances before NFTfi loans:',
        `\tStructurer: ${results[0]/10**18}`,
        `\tBorrower 1: ${results[1]/10**18}`,
        `\tBorrower 2: ${results[2]/10**18}`,
    ))

    // Initiate NFTfi loans
    await Promise.all([
        acceptOffer(
            contracts,
            '1000000000000000000', // 1 ETH principal
            '1100000000000000000', // 1.1 ETH repayment ==> 10% interest, not annualized
            0,
            10000,
            0,
            structurerAcc,
            borrower1Acc,
        ),
        acceptOffer(
            contracts,
            '500000000000000000', // 0.5 ETH principal
            '700000000000000000', // 0.7 ETH repayment ==> 40% interest, not annualized
            1,
            10000,
            1,
            structurerAcc,
            borrower2Acc,
        ),
    ]);

    // Verify final wETH balances and verify promissory notes successfully issued
    await Promise.all([
        getLoanOwner(contracts, 1),
        getLoanOwner(contracts, 2),
        getWethBalance(contracts, structurerAcc),
        getWethBalance(contracts, borrower1Acc),
        getWethBalance(contracts, borrower2Acc),
    ]).then(results => {
        if (results[0] == structurerAcc) {
            console.log('NFTfi Promissory Note 1 issued to Structurer')
        }
        if (results[1] == structurerAcc) {
            console.log('NFTfi Promissory Note 2 issued to Structurer')
        }
        console.log(
            'wETH balances after NFTfi loans:',
            `\tStructurer: ${results[2]/10**18}`,
            `\tBorrower 1: ${results[3]/10**18}`,
            `\tBorrower 2: ${results[4]/10**18}`,
        )
    })
}

/* Main body of scenario test */
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

        const contracts = await init(miscAcc, nftfiAcc, borrower1Acc, borrower2Acc)
        await initiateLoans(contracts, structurerAcc, borrower1Acc, borrower2Acc)
    } catch (e) {
        console.error(e.message)
    }
})()